
import { Redis } from 'ioredis';
import process from 'process';
import { Buffer } from 'buffer';
import { Pool } from 'pg';
import { systemPool } from '../src/config/main.js';

export class SystemLogService {
    private static redis: Redis | null = null;
    private static LOG_KEY = 'sys:runtime_logs';
    private static MAX_LOGS = 1000;
    
    // Audit Log Batching (Firehose)
    private static auditBuffer: any[] = [];
    private static FLUSH_INTERVAL_MS = 5000; // 5 segundos
    private static BATCH_SIZE = 100;
    private static flushTimer: NodeJS.Timeout | null = null;

    public static init() {
        // CORREÇÃO 4.1: Logging de Workers Habilitado
        // Removido o 'return' prematuro para que workers também loguem.
        
        try {
            this.redis = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                lazyConnect: true
            });
            this.redis.connect().catch(() => {});
            this.hookConsole();
            
            // Inicia o Firehose de Audit Logs
            this.startAuditFirehose();
        } catch (e) { console.error("Failed to init SystemLogService", e); }
    }

    // --- RUNTIME LOGS (Redis List) ---

    private static hookConsole() {
        const originalStdout = process.stdout.write;
        const originalStderr = process.stderr.write;
        const serviceTag = `[${process.env.SERVICE_MODE || 'API'}]`;

        process.stdout.write = (chunk: any, ...args: any[]) => {
            this.pushLog('INFO', chunk, serviceTag);
            return originalStdout.apply(process.stdout, [chunk, ...args] as any);
        };

        process.stderr.write = (chunk: any, ...args: any[]) => {
            this.pushLog('ERROR', chunk, serviceTag);
            return originalStderr.apply(process.stderr, [chunk, ...args] as any);
        };

        console.log('[SystemLogService] Console hooks attached. Logs streaming to Redis.');
    }

    private static pushLog(level: 'INFO' | 'ERROR', message: string | Buffer, tag: string) {
        if (!this.redis || this.redis.status !== 'ready') return;
        
        const logEntry = JSON.stringify({
            ts: new Date().toISOString(),
            lvl: level,
            svc: tag, // Tagging para identificar Worker vs Control vs Data
            msg: message.toString().trim()
        });

        this.redis.lpush(this.LOG_KEY, logEntry).catch(() => {});
        this.redis.ltrim(this.LOG_KEY, 0, this.MAX_LOGS - 1).catch(() => {});
    }

    public static async getLogs(limit: number = 100): Promise<any[]> {
        if (!this.redis) return [];
        try {
            const rawLogs = await this.redis.lrange(this.LOG_KEY, 0, limit - 1);
            return rawLogs.map(l => JSON.parse(l));
        } catch (e) {
            return [{ ts: new Date().toISOString(), lvl: 'ERROR', msg: 'Failed to retrieve logs from Redis.' }];
        }
    }

    // --- AUDIT LOGS (Postgres Batching) ---
    // CORREÇÃO 1.2: Gargalo de Escrita (Write Amplification)

    private static startAuditFirehose() {
        if (this.flushTimer) clearInterval(this.flushTimer);
        this.flushTimer = setInterval(() => this.flushAuditLogs(), this.FLUSH_INTERVAL_MS);
    }

    public static bufferAuditLog(entry: any) {
        this.auditBuffer.push(entry);
        if (this.auditBuffer.length >= this.BATCH_SIZE) {
            this.flushAuditLogs();
        }
    }

    public static async flushAuditLogs() {
        if (this.auditBuffer.length === 0) return;

        const batch = [...this.auditBuffer];
        this.auditBuffer = []; // Clear immediate buffer

        try {
            const client = await systemPool.connect();
            try {
                // Construct Batch Insert Query
                const values: any[] = [];
                const placeholders: string[] = [];
                let paramIdx = 1;

                batch.forEach(log => {
                    placeholders.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
                    values.push(
                        log.project_slug, 
                        log.method, 
                        log.path, 
                        log.status_code, 
                        log.client_ip, 
                        log.duration_ms, 
                        log.user_role, 
                        log.payload, 
                        log.headers, 
                        log.geo_info
                    );
                });

                const query = `
                    INSERT INTO system.api_logs 
                    (project_slug, method, path, status_code, client_ip, duration_ms, user_role, payload, headers, geo_info) 
                    VALUES ${placeholders.join(', ')}
                `;

                await client.query(query, values);
                // console.log(`[SystemLogService] Flushed ${batch.length} audit logs to DB.`);

            } finally {
                client.release();
            }
        } catch (e) {
            console.error('[SystemLogService] Failed to flush audit logs:', e);
            // Optional: Re-queue failed logs or fallback to Redis if critical
            // this.auditBuffer.push(...batch); // Caution: Infinite loop risk
        }
    }

    public static async shutdown() {
        if (this.flushTimer) clearInterval(this.flushTimer);
        await this.flushAuditLogs(); // Last flush
        if (this.redis) this.redis.disconnect();
    }
}
