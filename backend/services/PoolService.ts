
import pg from 'pg';
import { Buffer } from 'buffer';
import { URL } from 'url';
import { systemPool } from '../src/config/main.js';
import { VaultService } from './VaultService.js';
import process from 'process';

const { Pool } = pg;

export interface PoolConfig {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeout?: number;
  useDirect?: boolean; 
  connectionString?: string; 
}

interface PoolEntry {
    pool: pg.Pool;
    lastAccessed: number;
    activeConnections: number;
    isExternal: boolean;
}

/**
 * PoolService v5.4 (SSL Logic Fixed)
 * Gerenciamento avançado de conexões e limpeza de transações órfãs.
 */
export class PoolService {
  private static pools = new Map<string, PoolEntry>();
  private static REAPER_INTERVAL_MS = 20 * 1000; // Check mais frequente (20s)
  private static IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutos de inatividade do pool
  private static MAX_ACTIVE_POOLS = 500; 
  private static DEFAULT_STATEMENT_TIMEOUT = 15000; 
  private static MAX_IDLE_TX_TIME = '2 minutes'; // Tempo máximo para IDLE IN TRANSACTION

  private static reaperInterval: any = null;

  public static configure(config: { maxConnections?: number, idleTimeout?: number, statementTimeout?: number }) {
      if (config.statementTimeout) {
          this.DEFAULT_STATEMENT_TIMEOUT = config.statementTimeout;
      }
  }

  public static initReaper() {
      if (this.reaperInterval) clearInterval(this.reaperInterval);
      
      this.reaperInterval = setInterval(() => {
          this.reapZombies();
          this.killIdleTransactions().catch(e => {
              const err = e as Error;
              console.error('[PoolService] Idle Killer Failed:', err.message);
          });
      }, this.REAPER_INTERVAL_MS);
      
      console.log('[PoolService] Smart Reaper initialized (Aggressive Mode).');
  }

  public static getTotalActivePools(): number {
      return this.pools.size;
  }

  /**
   * Mata transações que estão 'idle in transaction' por mais de X minutos.
   * Isso previne que clientes com bugs bloqueiem tabelas (Row Locks) indefinidamente.
   */
  private static async killIdleTransactions() {
      try {
          const res = await systemPool.query(`
              SELECT pg_terminate_backend(pid), datname, usename, query, state_change
              FROM pg_stat_activity
              WHERE state = 'idle in transaction'
              AND state_change < NOW() - INTERVAL '${this.MAX_IDLE_TX_TIME}'
              AND datname IS NOT NULL
              AND pid <> pg_backend_pid() -- Don't kill self
          `);
          
          if (res.rowCount && res.rowCount > 0) {
              console.warn(`[PoolService] ☢️  Killed ${res.rowCount} zombie transactions (Idle > ${this.MAX_IDLE_TX_TIME}).`);
          }
      } catch (e: unknown) {
          const err = e as { code?: string; message: string };
          // Ignora erros pontuais (ex: DB reiniciando)
          if (err.code !== '57P03') console.error('[PoolService] Zombie Killer Error:', err.message);
      }
  }

  private static reapZombies() {
      const now = Date.now();
      let closedCount = 0;
      
      const entries = Array.from(this.pools.entries()).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

      for (const [key, entry] of entries) {
          if (now - entry.lastAccessed > this.IDLE_THRESHOLD_MS) {
              this.gracefulClose(key, entry);
              closedCount++;
          }
      }

      if (this.pools.size > this.MAX_ACTIVE_POOLS) {
          const currentSize = this.pools.size;
          const toRemove = currentSize - this.MAX_ACTIVE_POOLS;
          
          if (toRemove > 0) {
              console.warn(`[PoolService] Hard Cap Reached (${currentSize}). Ejecting ${toRemove} oldest pools.`);
              const remainingEntries = entries.filter(([k]) => this.pools.has(k));
              for (let i = 0; i < toRemove && i < remainingEntries.length; i++) {
                  const [key, entry] = remainingEntries[i];
                  this.gracefulClose(key, entry);
                  closedCount++;
              }
          }
      }

      if (closedCount > 0) console.log(`[PoolService] Reaped ${closedCount} pools.`);
  }

  private static gracefulClose(key: string, entry: PoolEntry) {
      try {
          entry.pool.end().catch(e => console.error(`[PoolService] Error closing ${key}:`, (e as Error).message));
          this.pools.delete(key);
      } catch (e: unknown) {
          console.error(`[PoolService] Critical error removing pool ${key}`, (e as Error).message);
      }
  }

  public static async get(dbIdentifier: string, config?: PoolConfig): Promise<pg.Pool> {
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

    let dbUrl: string;
    let isExternal = false;

    if (config?.connectionString) {
        dbUrl = config.connectionString;
        
        // Smart Detection: Check if host is internal or external
        try {
            // Se dbUrl não tem protocolo, tenta adicionar para parsear (fallback simples)
            const urlStr = dbUrl.includes('://') ? dbUrl : `postgres://${dbUrl}`;
            const url = new URL(urlStr);
            const internalHosts = [
                process.env.DB_DIRECT_HOST || 'db',
                process.env.DB_POOL_HOST || 'pgbouncer',
                'localhost',
                '127.0.0.1'
            ];
            
            // Se o hostname NÃO estiver na lista de internos, é externo (ex: Supabase, Neon, AWS)
            if (!internalHosts.includes(url.hostname)) {
                isExternal = true;
            }
        } catch(e) {
            // Se falhar o parse, assume externo por segurança (para não enviar credenciais em plain text)
            // exceto se contiver explicitamente nomes de container conhecidos
            if (!dbUrl.includes('db') && !dbUrl.includes('pgbouncer')) {
                isExternal = true;
            }
        }
    } else {
        const usePooler = !config?.useDirect;
        const host = usePooler ? (process.env.DB_POOL_HOST || 'pgbouncer') : (process.env.DB_DIRECT_HOST || 'db');
        const port = usePooler ? (process.env.DB_POOL_PORT || '6432') : (process.env.DB_DIRECT_PORT || '5432');
        
        let user = process.env.DB_USER || 'cascata_admin';
        let pass = process.env.DB_PASS || 'secure_pass';

        // INTEGRAÇÃO ENTERPRISE: Busca credenciais dinâmicas no Vault
        if (process.env.VAULT_ADDR && process.env.VAULT_TOKEN) {
            try {
                const vault = VaultService.getInstance();
                const creds = await vault.getDatabaseCredentials('cascata-admin-role');
                user = creds.username;
                pass = creds.password;
                console.log(`[PoolService] Using dynamic credentials from Vault for ${dbIdentifier}`);
            } catch (vaultErr) {
                console.warn(`[PoolService] Vault credentials fetch failed for ${dbIdentifier}, falling back to ENV.`, (vaultErr as Error).message);
            }
        }
        
        // CASCATA ENTERPRISE SECURITY & RELIABILITY PATCH:
        // By strictly encoding the credentials here via `encodeURIComponent`, any DB pass containing "@", "#" or "%"
        // will safely parse avoiding the fatal ERR_INVALID_URL exception breaking all resolution pipelines. 
        dbUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${dbIdentifier}`;
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

    pool.on('connect', (client: pg.PoolClient) => {
        client.query(`SET statement_timeout TO ${statementTimeout}`).catch((err: Error) => {
            console.warn(`[PoolService] Failed to set statement_timeout on ${uniqueKey}`, err.message);
        });
    });

    pool.on('error', (err: Error) => {
      console.error(`[PoolService] Error on ${uniqueKey}:`, err.message);
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
    
    if (this.pools.size > this.MAX_ACTIVE_POOLS) {
        this.reapZombies();
    }
    
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
      } catch (e: unknown) {
          console.error(`[PoolService] Failed to terminate backend connections for ${dbName}:`, (e as Error).message);
      }
  }

  public static async closeAll(): Promise<void> {
      const promises = Array.from(this.pools.values()).map(entry => entry.pool.end().catch(() => {}));
      await Promise.all(promises);
      this.pools.clear();
      console.log('[PoolService] All pools closed.');
  }
}
