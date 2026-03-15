
import { systemPool } from '../src/config/main.js';
import { QueueService } from './QueueService.js';

/**
 * CRON SERVICE
 * Manages scheduled automations using BullMQ repeatable jobs.
 */
export class CronService {

    /**
     * Initializes the Cron Service by syncing all active scheduled automations.
     */
    public static async init() {
        console.log('[CronService] Initializing Scheduled Automations...');
        await this.syncAllSchedules();
    }

    /**
     * Scans the system database for all active scheduled automations and registers them.
     */
    public static async syncAllSchedules() {
        try {
            const res = await systemPool.query(
                `SELECT id, project_slug, nodes, trigger_config 
                 FROM system.automations 
                 WHERE is_active = true 
                 AND trigger_type = 'SCHEDULED'`
            );

            for (const auto of res.rows) {
                await this.registerAutomation(auto);
            }
            console.log(`[CronService] Synchronized ${res.rows.length} scheduled automations.`);
        } catch (e: any) {
            console.error('[CronService] Sync failed:', e.message);
        }
    }

    /**
     * Registers a single automation schedule in the queue.
     */
    public static async registerAutomation(automation: any) {
        const { id, project_slug, trigger_config, nodes } = automation;
        const cronPattern = trigger_config?.cron || trigger_config?.pattern;
        
        if (!cronPattern) {
            // console.warn(`[CronService] Automation ${id} has no valid cron pattern.`);
            return;
        }

        try {
            await QueueService.scheduleAutomation(id, cronPattern, project_slug, nodes);
        } catch (e: any) {
            console.error(`[CronService] Failed to register automation ${id}:`, e.message);
        }
    }

    /**
     * Removes an automation schedule from the queue.
     */
    public static async unregisterAutomation(automationId: string) {
        try {
            await QueueService.removeAutomationSchedule(automationId);
        } catch (e: any) {
            console.error(`[CronService] Failed to unregister automation ${automationId}:`, e.message);
        }
    }
}
