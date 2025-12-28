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

export class WebhookService {
    
    /**
     * Enfileira webhooks para processamento assíncrono e resiliente.
     */
    public static async dispatch(
        projectSlug: string,
        tableName: string,
        eventType: string,
        payloadData: any,
        systemPool: Pool,
        projectSecret: string
    ) {
        try {
            // 1. Buscar webhooks ativos para este projeto e tabela
            const res = await systemPool.query(
                `SELECT target_url, secret_header, event_type 
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

            // 2. Enviar para a Fila (QueueService)
            // Agora é Non-Blocking e Persistente
            for (const hook of res.rows) {
                await QueueService.addWebhookJob({
                    targetUrl: hook.target_url,
                    payload: fullPayload,
                    secret: hook.secret_header || projectSecret,
                    eventType: eventType,
                    tableName: tableName
                });
            }

        } catch (e) {
            console.error('[WebhookService] Enqueue Error:', e);
        }
    }
}