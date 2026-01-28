
import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';
import axios from 'axios';
import { URL } from 'url';
import dns from 'dns/promises';
import { systemPool } from '../src/config/main.js';
import { PoolService } from './PoolService.js';
import { PushProcessor } from './PushProcessor.js';
import { BackupService } from './BackupService.js';

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
    
    private static pushWorker: Worker;
    private static backupWorker: Worker;

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

        // 1. Webhook Queue
        this.webhookQueue = new Queue('cascata-webhooks', {
            ...REDIS_CONFIG,
            defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 1000 } }
        });

        // 2. Push Notification Queue
        this.pushQueue = new Queue('cascata-push', {
            ...REDIS_CONFIG,
            defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 }
        });

        // 3. Backup Scheduler Queue
        this.backupQueue = new Queue('cascata-backups', {
            ...REDIS_CONFIG
        });

        // --- WORKERS ---

        // Push Worker
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
        }, { ...REDIS_CONFIG, concurrency: 2 }); // Limit concurrency to avoid overloading CPU with compression
    }

    public static async addPushJob(data: any) {
        if (!this.pushQueue) this.init();
        await this.pushQueue.add('send', data, { attempts: 3, backoff: { type: 'fixed', delay: 2000 } });
    }

    public static async addWebhookJob(data: any) {
        if (!this.webhookQueue) this.init();
        await this.webhookQueue.add('dispatch', data);
    }

    // --- AGENDAMENTO DE BACKUP ---
    public static async scheduleBackup(policyId: string, cron: string, timezone: string = 'UTC') {
        if (!this.backupQueue) this.init();
        
        // Remove existing schedule for this policy to avoid duplicates/zombies
        const repeatableJobs = await this.backupQueue.getRepeatableJobs();
        const existing = repeatableJobs.find(j => j.id === `backup-${policyId}`);
        if (existing) {
            await this.backupQueue.removeRepeatableByKey(existing.key);
        }

        // Add new schedule with TZ
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
