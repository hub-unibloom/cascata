
import { NextFunction, Response } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool, SYS_SECRET } from '../config/main.js';
import { AutomationService } from '../../services/AutomationService.js';
import { PoolService } from '../../services/PoolService.js';
import crypto from 'crypto';

export class WebhookController {
    
    // --- Management (Admin) ---

    static async list(req: CascataRequest, res: Response, next: NextFunction) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { slug } = req.params;
        try {
            const result = await systemPool.query(
                `SELECT id, name, path_slug, auth_method, target_type, target_id, is_active, created_at 
                 FROM system.webhook_receivers WHERE project_slug = $1 ORDER BY created_at DESC`,
                [slug]
            );
            res.json(result.rows);
        } catch (e) { next(e); }
    }

    static async create(req: CascataRequest, res: Response, next: NextFunction) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { slug } = req.params;
        const { name, path_slug, auth_method, secret_key, target_type, target_id } = req.body;
        try {
            const result = await systemPool.query(
                `INSERT INTO system.webhook_receivers (project_slug, name, path_slug, auth_method, secret_key, target_type, target_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [slug, name, path_slug, auth_method, secret_key, target_type, target_id]
            );
            res.json(result.rows[0]);
        } catch (e: any) {
            if (e.code === '23505') return res.status(400).json({ error: 'Path slug already in use for this project.' });
            next(e);
        }
    }

    static async delete(req: CascataRequest, res: Response, next: NextFunction) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { id } = req.params;
        try {
            await systemPool.query(`DELETE FROM system.webhook_receivers WHERE id = $1`, [id]);
            res.json({ success: true });
        } catch (e) { next(e); }
    }

    // --- Execution (Public Gateway) ---

     static async handleIncoming(req: any, res: Response) {
        const { projectSlug, pathSlug } = req.params;
        const payload = req.body;
        const headers = req.headers;

        try {
            // 1. Fetch search automation with WEBHOOK_IN trigger matching path_slug
            // SYNERGY: We search directly in system.automations where it's a webhook and path matches.
            const query = `
                SELECT 
                    a.id, a.nodes, a.trigger_config,
                    p.db_name, pg_sym_decrypt(p.jwt_secret::bytea, $3) as jwt_secret
                FROM system.automations a
                JOIN system.projects p ON a.project_slug = p.slug
                WHERE a.project_slug = $1 
                  AND a.trigger_type = 'WEBHOOK_IN'
                  AND a.trigger_config->>'path_slug' = $2 
                  AND a.is_active = true
            `;
            const result = await systemPool.query(query, [projectSlug, pathSlug, SYS_SECRET]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Webhook endpoint not found or inactive.' });
            }

            const automation = result.rows[0];
            const config = automation.trigger_config || {};

            // 2. Validate Security (HMAC SHA256)
            if (config.auth_method === 'hmac_sha256' && config.secret_key) {
                const signature = headers['x-cascata-signature'] || headers['x-hub-signature-256'] || headers['x-signature'];
                if (!signature) return res.status(401).json({ error: 'Missing security signature.' });
                
                const hmac = crypto.createHmac('sha256', config.secret_key);
                const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
                const expected = hmac.update(bodyStr).digest('hex');
                
                if (signature !== expected) {
                    return res.status(401).json({ error: 'Invalid security signature.' });
                }
            }

            // 3. Dispatch Trigger
            const projectPool = PoolService.get(automation.db_name);
            AutomationService.dispatchAsyncTrigger(
                automation.id,
                projectSlug,
                automation.nodes,
                payload,
                { 
                    vars: {}, 
                    payload,
                    projectSlug, 
                    jwtSecret: automation.jwt_secret, 
                    projectPool 
                }
            );

            res.json({ success: true, message: 'Webhook event received and processing.' });

        } catch (e: any) {
            console.error('[WebhookIn] Error:', e.message);
            res.status(500).json({ error: 'Internal failure processing incoming webhook.' });
        }
    }
}
