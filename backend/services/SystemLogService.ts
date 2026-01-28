
import { Redis } from 'ioredis';

/**
 * SystemLogService
 * Captures process-level logs (stdout/stderr) and persists them in Redis
 * for consumption by the Control Plane UI.
 */
export class SystemLogService {
    private static redis: Redis | null = null;
    private static LOG_KEY = 'sys:runtime_logs';
    private static MAX_LOGS = 1000; // Keep last 1000 logs

    public static init() {
        if (process.env.SERVICE_MODE === 'WORKER') return; // Workers log to stdout only

        try {
            this.redis = new Redis({
                host: process.env.REDIS_HOST || 'redis',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                lazyConnect: true
            });
            this.redis.connect().catch(() => {});
            this.hookConsole();
        } catch (e) { console.error("Failed to init SystemLogService", e); }
    }

    private static hookConsole() {
        const originalStdout = process.stdout.write;
        const originalStderr = process.stderr.write;

        // Hook Stdout
        process.stdout.write = (chunk: any, ...args: any[]) => {
            this.pushLog('INFO', chunk);
            return originalStdout.apply(process.stdout, [chunk, ...args] as any);
        };

        // Hook Stderr
        process.stderr.write = (chunk: any, ...args: any[]) => {
            this.pushLog('ERROR', chunk);
            return originalStderr.apply(process.stderr, [chunk, ...args] as any);
        };

        console.log('[SystemLogService] Console hooks attached. Logs streaming to Redis.');
    }

    private static pushLog(level: 'INFO' | 'ERROR', message: string | Buffer) {
        if (!this.redis || this.redis.status !== 'ready') return;
        
        const logEntry = JSON.stringify({
            ts: new Date().toISOString(),
            lvl: level,
            msg: message.toString().trim()
        });

        // Fire and forget push + trim
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
}
