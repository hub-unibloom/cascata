
import { Redis } from 'ioredis';
import process from 'process';
import { Buffer } from 'buffer';
import { Pool } from 'pg';
import { systemPool } from '../src/config/main.js';

export class SystemLogService {
    private static dragonfly: Redis | null = null;
    private static LOG_KEY = 'sys:runtime_logs'; // Logs de console (stdout)
    private static AUDIT_KEY = 'sys:audit_buffer'; // Logs de auditoria (banco)
    private static MAX_RUNTIME_LOGS = 1000;
    
    // Configurações do Batch Processor
    private static FLUSH_INTERVAL_MS = 2000; // 2 segundos
    private static BATCH_SIZE = 500; // Até 500 logs por insert
    private static MAX_BUFFER_SIZE = 100000; // Proteção contra estouro de memória no Dragonfly
    private static flushTimer: any = null;
    private static isFlushing = false;

    public static init() {
        try {
            // Usa conexão lazy para não bloquear o boot se o Dragonfly demorar
            this.dragonfly = new Redis({
                host: process.env.DRAGONFLY_HOST || 'dragonfly',
                port: parseInt(process.env.DRAGONFLY_PORT || '6379'),
                lazyConnect: true,
                maxRetriesPerRequest: 1, // Falha rápido para não segurar a API
                retryStrategy: (times: number) => Math.min(times * 100, 2000)
            });

            this.dragonfly.connect().catch((e: any) => console.error('[SystemLog] Dragonfly connection warning (Background):', e.message));
            
            // Inicia Hooks e Workers
            this.hookConsole();
            this.startAuditWorker();
            
            console.log('[SystemLogService] Decoupled Logging Engine Initialized (Dragonfly Buffer Mode).');
        } catch (e) { console.error("Failed to init SystemLogService", e); }
    }

    // --- RUNTIME LOGS (Console Capture) ---

    private static hookConsole() {
        const originalStdout = process.stdout.write;
        const originalStderr = process.stderr.write;
        const serviceTag = `[${process.env.SERVICE_MODE || 'API'}]`;

        // Override não-bloqueante
        process.stdout.write = (chunk: any, ...args: any[]) => {
            this.pushRuntimeLog('INFO', chunk, serviceTag);
            return originalStdout.apply(process.stdout, [chunk, ...args] as any);
        };

        process.stderr.write = (chunk: any, ...args: any[]) => {
            this.pushRuntimeLog('ERROR', chunk, serviceTag);
            return originalStderr.apply(process.stderr, [chunk, ...args] as any);
        };
    }

    private static pushRuntimeLog(level: 'INFO' | 'ERROR', message: string | Buffer, tag: string) {
        if (!this.dragonfly || this.dragonfly.status !== 'ready') return;
        
        // Fire-and-forget: Não espera resposta do Dragonfly
        const logEntry = JSON.stringify({
            ts: new Date().toISOString(),
            lvl: level,
            svc: tag, 
            msg: message.toString().trim()
        });

        this.dragonfly.lpush(this.LOG_KEY, logEntry).catch(() => {});
        // Mantém tamanho fixo para não estourar RAM do Dragonfly
        this.dragonfly.ltrim(this.LOG_KEY, 0, this.MAX_RUNTIME_LOGS - 1).catch(() => {});
    }

    public static async getLogs(limit: number = 100): Promise<any[]> {
        if (!this.dragonfly) return [];
        try {
            const rawLogs = await this.dragonfly.lrange(this.LOG_KEY, 0, limit - 1);
            return rawLogs.map((l: string) => JSON.parse(l));
        } catch (e: any) {
            return [{ ts: new Date().toISOString(), lvl: 'ERROR', msg: 'Logs indisponíveis (Dragonfly offline).' }];
        }
    }

    // --- AUDIT LOGS (Decoupled Architecture) ---

    /**
     * Entrada de Alta Performance.
     * Apenas serializa e joga no Dragonfly. Retorno imediato.
     */
    public static bufferAuditLog(entry: any) {
        if (!this.dragonfly || this.dragonfly.status !== 'ready') {
            // Fallback seguro: se Dragonfly cair, loga no console para não perder, mas não trava API
            console.warn('[Audit] Dragonfly offline, log dropped to stdout:', JSON.stringify(entry));
            return;
        }

        const serialized = JSON.stringify(entry);
        
        // Pipeline para atomicidade e performance
        const pipeline = this.dragonfly.pipeline();
        pipeline.lpush(this.AUDIT_KEY, serialized);
        // Cap de segurança: se o worker morrer, não enchemos o Dragonfly infinitamente
        pipeline.ltrim(this.AUDIT_KEY, 0, this.MAX_BUFFER_SIZE - 1);
        pipeline.exec().catch(() => {});
    }

    private static startAuditWorker() {
        if (this.flushTimer) clearInterval(this.flushTimer);
        this.flushTimer = setInterval(() => this.flushAuditLogs(), this.FLUSH_INTERVAL_MS);
    }

    /**
     * Sanitizes payload to ensure it is valid JSONB for Postgres.
     * Prevents 'invalid input syntax for type json' crashes.
     */
    private static sanitizeJsonb(data: any): string {
        if (typeof data === 'string') {
            // Try to parse to see if it's valid JSON
            try {
                JSON.parse(data);
                return data; // It's valid JSON string
            } catch (e) {
                // It's a raw string (e.g. SQL Query), wrap it to make it valid JSON
                return JSON.stringify({ raw_content: data });
            }
        }
        // It's an object/array, safe to stringify
        return JSON.stringify(data);
    }

    /**
     * Worker Dedicado de Ingestão.
     * Roda fora do ciclo de request/response.
     */
    public static async flushAuditLogs() {
        if (this.isFlushing || !this.dragonfly || this.dragonfly.status !== 'ready') return;
        this.isFlushing = true;

        try {
            const len = await this.dragonfly.llen(this.AUDIT_KEY);
            if (len === 0) {
                this.isFlushing = false;
                return;
            }

            const batchSize = Math.min(len, this.BATCH_SIZE);
            const batch: any[] = [];
            
            // Pipeline de leitura para performance (RPOP = FIFO)
            const readPipe = this.dragonfly.pipeline();
            for (let i = 0; i < batchSize; i++) readPipe.rpop(this.AUDIT_KEY);
            const results = await readPipe.exec();

            if (!results) {
                this.isFlushing = false;
                return;
            }

            results.forEach((result: any) => {
                const [err, res] = result;
                if (!err && res) {
                    try { batch.push(JSON.parse(res as string)); } catch(e) {}
                }
            });

            if (batch.length === 0) {
                this.isFlushing = false;
                return;
            }

            // 2. Bulk Insert no Postgres
            const client = await systemPool.connect();
            try {
                const values: any[] = [];
                const placeholders: string[] = [];
                let paramIdx = 1;

                batch.forEach(log => {
                    placeholders.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
                    
                    // CRITICAL FIX: Ensure payload/headers/geo_info are valid JSON strings
                    const safePayload = this.sanitizeJsonb(log.payload);
                    const safeHeaders = this.sanitizeJsonb(log.headers);
                    const safeGeo = this.sanitizeJsonb(log.geo_info);

                    values.push(
                        log.project_slug, 
                        log.method, 
                        log.path, 
                        log.status_code, 
                        log.client_ip, 
                        log.duration_ms, 
                        log.user_role, 
                        safePayload, 
                        safeHeaders, 
                        safeGeo,
                        log.response_size || 0 
                    );
                });

                const query = `
                    INSERT INTO system.api_logs 
                    (project_slug, method, path, status_code, client_ip, duration_ms, user_role, payload, headers, geo_info, response_size) 
                    VALUES ${placeholders.join(', ')}
                `;

                await client.query(query, values);

            } catch (dbErr) {
                console.error('[SystemLogService] DB Insert Failed. Logs lost to protect service health.', dbErr);
            } finally {
                client.release();
            }

        } catch (e) {
            console.error('[SystemLogService] Worker Loop Error:', e);
        } finally {
            this.isFlushing = false;
        }
    }

    public static async shutdown() {
        console.log('[SystemLogService] Graceful shutdown...');
        if (this.flushTimer) clearInterval(this.flushTimer);
        
        // Tenta um último flush forçado
        await this.flushAuditLogs();
        
        if (this.dragonfly) this.dragonfly.disconnect();
    }
}
