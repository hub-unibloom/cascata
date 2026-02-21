
import { Pool } from 'pg';
import { QueueService } from './QueueService.js';

interface WebhookPayload {
    event_type: 'INSERT' | 'UPDATE' | 'DELETE';
    table: string;
    schema: string;
    record: any;
    old_record?: any;
    timestamp: string;
}

interface FilterRule {
    field: string;
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'starts_with';
    value: string;
}

export class WebhookService {
    
    private static matchesFilters(record: any, filters: FilterRule[]): boolean {
        if (!filters || filters.length === 0) return true;
        if (!record) return false;

        for (const rule of filters) {
            const recordValue = record[rule.field];
            const valA = recordValue; 
            const valB = rule.value;

            if (valA === undefined) return false;

            switch (rule.operator) {
                case 'eq': if (valA != valB) return false; break;
                case 'neq': if (valA == valB) return false; break;
                case 'gt': if (Number(valA) <= Number(valB)) return false; break;
                case 'lt': if (Number(valA) >= Number(valB)) return false; break;
                case 'contains': if (!String(valA).toLowerCase().includes(String(valB).toLowerCase())) return false; break;
                case 'starts_with': if (!String(valA).startsWith(String(valB))) return false; break;
                default: return false;
            }
        }
        return true;
    }

    public static async dispatch(
        projectSlug: string,
        tableName: string,
        eventType: string,
        payloadData: any,
        systemPool: Pool,
        projectSecret: string
    ) {
        try {
            // 1. Buscar webhooks com fallback e retry policy
            const res = await systemPool.query(
                `SELECT target_url, secret_header, event_type, filters, fallback_url, retry_policy 
                 FROM system.webhooks 
                 WHERE project_slug = $1 
                 AND is_active = true 
                 AND (table_name = '*' OR table_name = $2)
                 AND (event_type = '*' OR event_type = $3)`,
                [projectSlug, tableName, eventType]
            );

            if (res.rows.length === 0) return;

            const fullPayload: WebhookPayload = {
                event_type: eventType as any,
                table: tableName,
                schema: 'public',
                record: payloadData,
                timestamp: new Date().toISOString()
            };

            let dispatchedCount = 0;

            for (const hook of res.rows) {
                const filters = hook.filters as FilterRule[];
                if (!this.matchesFilters(payloadData, filters)) {
                    continue; 
                }

                await QueueService.addWebhookJob({
                    targetUrl: hook.target_url,
                    payload: fullPayload,
                    secret: hook.secret_header || projectSecret,
                    eventType: eventType,
                    tableName: tableName,
                    // New Reliability Fields
                    fallbackUrl: hook.fallback_url,
                    retryPolicy: hook.retry_policy
                });
                dispatchedCount++;
            }
            
            if (dispatchedCount > 0) {
                console.log(`[WebhookService] Dispatched ${dispatchedCount} events for ${tableName} (${eventType})`);
            }

        } catch (e) {
            console.error('[WebhookService] Enqueue Error:', e);
        }
    }
}
