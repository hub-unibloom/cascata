
import { Pool } from 'pg';
import { QueueService } from './QueueService.js';

interface FcmConfig {
    project_id: string;
    client_email: string;
    private_key: string;
}

/**
 * PushService (Producer)
 * Handles Device Registration and Job Enqueueing.
 * Imports QueueService to dispatch jobs.
 */
export class PushService {
    
    public static async registerDevice(pool: Pool, userId: string, token: string, platform: string = 'other', appVersion?: string) {
        // Ensure one active token per user (optional policy, can be adjusted)
        await pool.query(`DELETE FROM auth.user_devices WHERE token = $1 AND user_id != $2`, [token, userId]);
        
        await pool.query(`
            INSERT INTO auth.user_devices (user_id, token, platform, app_version, last_active_at, is_active)
            VALUES ($1, $2, $3, $4, NOW(), true)
            ON CONFLICT (user_id, token) 
            DO UPDATE SET last_active_at = NOW(), is_active = true, app_version = EXCLUDED.app_version
        `, [userId, token, platform, appVersion]);
        return { success: true };
    }

    /**
     * PRODUCER: Adiciona na fila do DragonflyDB
     */
    public static async sendToUser(pool: Pool, systemPool: Pool, projectSlug: string, userId: string, notification: any, fcmConfig: FcmConfig) {
        const dbName = `cascata_db_${projectSlug.replace(/-/g, '_')}`;
        
        await QueueService.addPushJob({
            projectSlug,
            userId,
            notification,
            fcmConfig,
            dbName
        });

        return { success: true, status: 'queued' };
    }

    public static async processEventTrigger(projectSlug: string, pool: Pool, systemPool: Pool, event: any, fcmCredentials: any) {
        if (!fcmCredentials) return;

        const rulesRes = await systemPool.query(
            `SELECT * FROM system.notification_rules 
             WHERE project_slug = $1 AND trigger_table = $2 AND (trigger_event = $3 OR trigger_event = 'ALL') AND active = true`,
            [projectSlug, event.table, event.action]
        );

        if (rulesRes.rows.length === 0) return;

        const recRes = await pool.query(`SELECT * FROM public."${event.table}" WHERE id = $1`, [event.record_id]);
        const record = recRes.rows[0];
        if (!record) return;

        for (const rule of rulesRes.rows) {
            const userId = record[rule.recipient_column];
            if (!userId) continue;

            let title = rule.title_template;
            let body = rule.body_template;
            
            // Simple Template Replacement
            Object.keys(record).forEach(key => {
                const val = record[key] !== null ? String(record[key]) : '';
                title = title.replace(new RegExp(`{{${key}}}`, 'g'), val);
                body = body.replace(new RegExp(`{{${key}}}`, 'g'), val);
            });

            await this.sendToUser(pool, systemPool, projectSlug, userId, { title, body, data: rule.data_payload }, fcmCredentials);
        }
    }
}
