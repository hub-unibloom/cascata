
import pg from 'pg';
import { Buffer } from 'buffer';
import { systemPool } from '../src/config/main.js';

const { Pool } = pg;

export interface PoolConfig {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeout?: number;
  useDirect?: boolean; // Força conexão direta (bypass PgBouncer)
  connectionString?: string; // NOVO: Permite conexão externa (RDS, VPS Dedicada)
}

interface PoolEntry {
    pool: pg.Pool;
    lastAccessed: number;
    activeConnections: number;
    isExternal: boolean;
}

/**
 * PoolService v5.4 (Resource Guard)
 * Gerenciamento de conexões com limite estrito de instâncias e limpeza agressiva.
 */
export class PoolService {
  private static pools = new Map<string, PoolEntry>();
  private static REAPER_INTERVAL_MS = 20 * 1000; 
  private static IDLE_THRESHOLD_MS = 2 * 60 * 1000; // Reduced to 2 minutes for faster rotation
  private static MAX_ACTIVE_POOLS = 200; // Strict limit on concurrent Pool objects in Node process
  private static DEFAULT_STATEMENT_TIMEOUT = 15000; 
  private static MAX_IDLE_TX_TIME = '2 minutes'; 

  public static configure(config: { maxConnections?: number, idleTimeout?: number, statementTimeout?: number }) {
      if (config.statementTimeout) {
          this.DEFAULT_STATEMENT_TIMEOUT = config.statementTimeout;
      }
  }

  public static initReaper() {
      if ((this as any)._reaperInterval) clearInterval((this as any)._reaperInterval);
      
      (this as any)._reaperInterval = setInterval(() => {
          this.reapZombies();
          this.killIdleTransactions().catch(e => console.error('[PoolService] Idle Killer Failed:', e));
      }, this.REAPER_INTERVAL_MS);
      
      console.log('[PoolService] Resource Guard initialized.');
  }

  public static getTotalActivePools(): number {
      return this.pools.size;
  }

  /**
   * Mata transações que estão 'idle in transaction' no banco.
   */
  private static async killIdleTransactions() {
      try {
          const res = await systemPool.query(`
              SELECT pg_terminate_backend(pid)
              FROM pg_stat_activity
              WHERE state = 'idle in transaction'
              AND state_change < NOW() - INTERVAL '${this.MAX_IDLE_TX_TIME}'
              AND datname IS NOT NULL
              AND pid <> pg_backend_pid()
          `);
          
          if (res.rowCount && res.rowCount > 0) {
              console.warn(`[PoolService] ☢️  Killed ${res.rowCount} zombie transactions.`);
          }
      } catch (e: any) {
          if (e.code !== '57P03') console.error('[PoolService] Zombie Killer Error:', e.message);
      }
  }

  private static reapZombies() {
      const now = Date.now();
      let closedCount = 0;
      
      const entries = Array.from(this.pools.entries()).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

      // 1. Idle Cleanup
      for (const [key, entry] of entries) {
          if (now - entry.lastAccessed > this.IDLE_THRESHOLD_MS) {
              this.gracefulClose(key, entry);
              closedCount++;
          }
      }

      // 2. Hard Cap Enforcement (Eviction Strategy)
      if (this.pools.size > this.MAX_ACTIVE_POOLS) {
          const currentSize = this.pools.size;
          const toRemove = currentSize - this.MAX_ACTIVE_POOLS;
          
          if (toRemove > 0) {
              console.warn(`[PoolService] Hard Cap Reached (${currentSize}). Evicting ${toRemove} oldest pools.`);
              // Filter entries again to ensure we don't double-remove if they were idle
              const remainingEntries = entries.filter(([k]) => this.pools.has(k));
              
              for (let i = 0; i < toRemove && i < remainingEntries.length; i++) {
                  const [key, entry] = remainingEntries[i];
                  this.gracefulClose(key, entry);
                  closedCount++;
              }
          }
      }

      if (closedCount > 0) console.log(`[PoolService] Cleanup: Reaped ${closedCount} pools.`);
  }

  private static gracefulClose(key: string, entry: PoolEntry) {
      // Don't await, let it drain in background
      entry.pool.end().catch(e => console.error(`[PoolService] Error closing ${key}:`, e.message));
      this.pools.delete(key);
  }

  public static get(dbIdentifier: string, config?: PoolConfig): pg.Pool {
    let uniqueKey = '';
    
    if (config?.connectionString) {
        const hash = Buffer.from(config.connectionString).toString('base64').slice(0, 10);
        uniqueKey = `ext_${dbIdentifier}_${hash}`;
    } else {
        uniqueKey = `${dbIdentifier}_${config?.useDirect ? 'direct' : 'pool'}`;
    }
    
    if (this.pools.has(uniqueKey)) {
      const entry = this.pools.get(uniqueKey)!;
      entry.lastAccessed = Date.now();
      return entry.pool;
    }

    // Force eviction if we are at capacity before creating new
    if (this.pools.size >= this.MAX_ACTIVE_POOLS) {
        this.reapZombies();
    }

    let dbUrl: string;
    let isExternal = false;

    if (config?.connectionString) {
        dbUrl = config.connectionString;
        isExternal = true;
    } else {
        const usePooler = !config?.useDirect;
        const host = usePooler ? (process.env.DB_POOL_HOST || 'pgbouncer') : (process.env.DB_DIRECT_HOST || 'db');
        const port = usePooler ? (process.env.DB_POOL_PORT || '6432') : (process.env.DB_DIRECT_PORT || '5432');
        const user = process.env.DB_USER || 'cascata_admin';
        const pass = process.env.DB_PASS || 'secure_pass';
        dbUrl = `postgresql://${user}:${pass}@${host}:${port}/${dbIdentifier}`;
    }

    const requestedMax = config?.max || 10;
    const statementTimeout = config?.statementTimeout || this.DEFAULT_STATEMENT_TIMEOUT;
    const appName = `cascata-${process.env.SERVICE_MODE || 'api'}-${isExternal ? 'ext' : 'int'}`;

    const poolConfig = {
      connectionString: dbUrl,
      max: requestedMax,
      idleTimeoutMillis: config?.idleTimeoutMillis || 60000, 
      connectionTimeoutMillis: config?.connectionTimeoutMillis || 5000, 
      keepAlive: true,
      application_name: appName,
      ssl: isExternal ? { rejectUnauthorized: false } : false 
    };

    const pool = new Pool(poolConfig);

    pool.on('connect', (client) => {
        client.query(`SET statement_timeout TO ${statementTimeout}`).catch(err => {
            console.warn(`[PoolService] Failed to set statement_timeout on ${uniqueKey}`, err.message);
        });
    });

    pool.on('error', (err) => {
      console.error(`[PoolService] Error on ${uniqueKey}:`, err.message);
      // Remove bad pool immediately
      if (this.pools.has(uniqueKey)) {
          this.pools.delete(uniqueKey);
      }
    });

    this.pools.set(uniqueKey, { 
        pool, 
        lastAccessed: Date.now(),
        activeConnections: requestedMax,
        isExternal
    });
    
    return pool;
  }

  public static async reload(dbName: string) {
      await this.close(dbName);
  }

  public static async close(dbIdentifier: string) {
    const keys = Array.from(this.pools.keys()).filter(k => k.includes(dbIdentifier));
    for (const key of keys) {
        const entry = this.pools.get(key);
        if (entry) {
            this.gracefulClose(key, entry);
        }
    }
  }

  public static async terminate(dbName: string) {
      console.log(`[PoolService] ☢️ TERMINATING ALL CONNECTIONS TO ${dbName}`);
      
      await this.close(dbName);

      try {
          await systemPool.query(`
              SELECT pg_terminate_backend(pid)
              FROM pg_stat_activity
              WHERE datname = $1
              AND pid <> pg_backend_pid()
          `, [dbName]);
      } catch (e: any) {
          console.error(`[PoolService] Failed to terminate backend connections for ${dbName}:`, e.message);
      }
  }

  public static async closeAll() {
      const promises = Array.from(this.pools.values()).map(entry => entry.pool.end().catch(() => {}));
      await Promise.all(promises);
      this.pools.clear();
      console.log('[PoolService] All pools closed.');
  }
}
