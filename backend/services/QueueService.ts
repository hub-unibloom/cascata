
import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';
import axios from 'axios';
import { URL } from 'url';
import dns from 'dns/promises';
import { systemPool } from '../src/config/main.js';
import { PoolService } from './PoolService.js';
import { PushProcessor } from './PushProcessor.js';
import { BackupService } from './BackupService.js';
import { ImportService } from './ImportService.js'; 
import process from 'process';

const REDIS_CONFIG = {
    connection: {
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379')
    },
    prefix: '{cascata}bull' // DRAGONFLY FIX: Hash Tag for atomic scripts
};

export class QueueService {
    private static webhookQueue: Queue;
    private static pushQueue: Queue;
    private static backupQueue: Queue;
    private static maintenanceQueue: Queue;
    private static restoreQueue: Queue; 
    
    private static pushWorker: Worker;
    private static backupWorker: Worker;
    private static maintenanceWorker: Worker;
    private static restoreWorker: Worker; 

    private static async validateTarget(targetUrl: string): Promise<void> {
        try {
            const url = new URL(targetUrl);
            const hostname = url.hostname;
            if (hostname === 'localhost' || hostname === 'db' || hostname === 'redis') {
                throw new Error("Internal access blocked");
            }
        } catch (e: any) { throw new Error(`Security Violation: ${e.message}`); }
    }

    public static init() {
        console.log('[QueueService] Initializing Queues with Redis (Dragonfly Mode)...');

        // ALWAYS Initialize Producers (Queues) so API can dispatch events
        this.webhookQueue = new Queue('cascata-webhooks', {
            ...REDIS_CONFIG,
            defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } }
        });

        this.pushQueue = new Queue('cascata-push', {
            ...REDIS_CONFIG,
            defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 }
        });

        this.backupQueue = new Queue('cascata-backups', { ...REDIS_CONFIG });

        this.maintenanceQueue = new Queue('cascata-maintenance', { ...REDIS_CONFIG });

        this.restoreQueue = new Queue('cascata-restore', { ...REDIS_CONFIG }); 

        // CRITICAL FIX: Enable Workers for CONTROL_PLANE to handle Imports/Backups
        const shouldRunWorkers = process.env.SERVICE_MODE === 'WORKER' || 
                                 process.env.SERVICE_MODE === 'CONTROL_PLANE' || 
                                 !process.env.SERVICE_MODE;

        if (shouldRunWorkers) {
            console.log(`[QueueService] Starting Workers (Mode: ${process.env.SERVICE_MODE || 'DEFAULT'})...`);
            this.startWorkers();
        } else {
            console.log('[QueueService] Data Plane Mode: Workers skipped (Producer Only).');
        }
    }

    private static startWorkers() {
        // Push Worker (High Concurrency)
        this.pushWorker = new Worker('cascata-push', async (job: Job) => {
            const { projectSlug, userId, notification, fcmConfig, dbName, externalDbUrl } = job.data;
            try {
                const pool = PoolService.get(dbName, { connectionString: externalDbUrl });
                return await PushProcessor.processDelivery(
                    pool,
                    systemPool,
                    projectSlug,
                    userId,
                    notification,
                    fcmConfig
                );
            } catch (error: any) {
                console.error(`[Queue:Push] Error:`, error.message);
                throw error;
            }
        }, { ...REDIS_CONFIG, concurrency: 50 });

        // Backup Worker
        this.backupWorker = new Worker('cascata-backups', async (job: Job) => {
            const { policyId } = job.data;
            try {
                await BackupService.executePolicyJob(policyId);
            } catch (error: any) {
                console.error(`[Queue:Backup] Error processing policy ${policyId}:`, error.message);
                throw error;
            }
        }, { ...REDIS_CONFIG, concurrency: 2 });

        // Maintenance Worker (Log Purge)
        this.maintenanceWorker = new Worker('cascata-maintenance', async (job: Job) => {
            if (job.name === 'purge-logs') {
                console.log('[Queue:Maintenance] Running global log purge...');
                try {
                    const projects = await systemPool.query('SELECT slug, log_retention_days FROM system.projects');
                    let totalPurged = 0;
                    for (const proj of projects.rows) {
                        const days = proj.log_retention_days || 30;
                        const res = await systemPool.query(`SELECT system.purge_old_logs($1, $2)`, [proj.slug, days]);
                        totalPurged += parseInt(res.rows[0].purge_old_logs);
                    }
                    console.log(`[Queue:Maintenance] Purged ${totalPurged} old logs.`);
                } catch (e: any) {
                    console.error('[Queue:Maintenance] Log purge failed:', e.message);
                }
            }
        }, { ...REDIS_CONFIG });

        // Restore/Import Worker (Heavy IO) - Single Concurrency for safety
        this.restoreWorker = new Worker('cascata-restore', async (job: Job) => {
            const { operationId, temp_path, slug, name, mode, include_data } = job.data;
            console.log(`[Queue:Restore] Starting import for ${slug} (Op: ${operationId})`);
            
            try {
                await systemPool.query('UPDATE system.async_operations SET status = $1, updated_at = NOW() WHERE id = $2', ['processing', operationId]);
                
                const result = await ImportService.restoreProject(temp_path, slug, systemPool, { mode, includeData: include_data, nameOverride: name });
                
                await systemPool.query('UPDATE system.async_operations SET status = $1, result = $2, updated_at = NOW() WHERE id = $3', ['completed', JSON.stringify(result), operationId]);
                console.log(`[Queue:Restore] Success for ${slug}`);
            } catch (e: any) {
                console.error(`[Queue:Restore] Failed for ${slug}:`, e.message);
                await systemPool.query('UPDATE system.async_operations SET status = $1, result = $2, updated_at = NOW() WHERE id = $3', ['failed', JSON.stringify({ error: e.message }), operationId]);
                throw e; 
            }
        }, { ...REDIS_CONFIG, concurrency: 1 }); 

        // Schedule Maintenance Jobs
        this.maintenanceQueue.add('purge-logs', {}, {
            repeat: { pattern: '0 4 * * *' },
            jobId: 'system-log-purge'
        }).catch(e => console.error("Failed to schedule log purge", e));
    }

    public static async addPushJob(data: any) {
        if (!this.pushQueue) this.init();
        await this.pushQueue.add('send', data, { attempts: 3, backoff: { type: 'fixed', delay: 2000 } });
    }

    public static async addWebhookJob(data: any) {
        if (!this.webhookQueue) this.init();
        await this.webhookQueue.add('dispatch', data);
    }

    public static async addRestoreJob(data: any) {
        if (!this.restoreQueue) this.init();
        await this.restoreQueue.add('restore-project', data, { jobId: `restore-${data.slug}-${Date.now()}` });
    }

    public static async scheduleBackup(policyId: string, cron: string, timezone: string = 'UTC') {
        if (!this.backupQueue) this.init();
        const repeatableJobs = await this.backupQueue.getRepeatableJobs();
        const existing = repeatableJobs.find(j => j.id === `backup-${policyId}`);
        if (existing) {
            await this.backupQueue.removeRepeatableByKey(existing.key);
        }
        await this.backupQueue.add('execute-policy', { policyId }, {
            jobId: `backup-${policyId}`,
            repeat: { pattern: cron, tz: timezone }
        });
        console.log(`[Queue] Scheduled backup ${policyId} with cron: ${cron} (TZ: ${timezone})`);
    }

    public static async removeBackupSchedule(policyId: string) {
        if (!this.backupQueue) this.init();
        const repeatableJobs = await this.backupQueue.getRepeatableJobs();
        const existing = repeatableJobs.find(j => j.id === `backup-${policyId}`);
        if (existing) {
            await this.backupQueue.removeRepeatableByKey(existing.key);
            console.log(`[Queue] Removed schedule for ${policyId}`);
        }
    }

    public static async triggerBackupNow(policyId: string) {
        if (!this.backupQueue) this.init();
        await this.backupQueue.add('execute-policy', { policyId });
    }
}
