
import { NextFunction, Response } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool, SYS_SECRET } from '../config/main.js';
import { AutomationService } from '../../services/AutomationService.js';
import { PoolService } from '../../services/PoolService.js';
import { VaultService } from '../../services/VaultService.js';
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

    static sanitizeSlug(slug: string): string {
        return slug
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9-_]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    static async create(req: CascataRequest, res: Response, next: NextFunction) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { slug } = req.params;
        let { name, path_slug, auth_method, secret_key, target_type, target_id } = req.body;
        
        path_slug = WebhookController.sanitizeSlug(path_slug || '');
        if (!path_slug) return res.status(400).json({ error: 'Invalid or missing path slug.' });

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
            // 1. Fetch receiver + project context
            const query = `
                SELECT r.*, p.db_name, p.jwt_secret
                FROM system.webhook_receivers r
                JOIN system.projects p ON r.project_slug = p.slug
                WHERE r.project_slug = $1 AND r.path_slug = $2 AND r.is_active = true
            `;
            const result = await systemPool.query(query, [projectSlug, pathSlug]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Webhook receiver not found or inactive.' });
            }

            const receiver = result.rows[0];

            // 2. Validate Security (HMAC SHA256)
            if (receiver.auth_method === 'hmac_sha256' && receiver.secret_key) {
                const signature = headers['x-cascata-signature'] || headers['x-hub-signature-256'] || headers['x-signature'];
                if (!signature) return res.status(401).json({ error: 'Missing security signature.' });

                const hmac = crypto.createHmac('sha256', receiver.secret_key);
                const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
                const expected = hmac.update(bodyStr).digest('hex');

                if (signature !== expected) {
                    return res.status(401).json({ error: 'Invalid security signature.' });
                }
            }

            // 3. Dispatch to Target
            if (receiver.target_type === 'AUTOMATION') {
                const autoRes = await systemPool.query(`SELECT nodes FROM system.automations WHERE id = $1`, [receiver.target_id]);
                if (autoRes.rows.length > 0) {
                    const projectPool = await PoolService.get(receiver.db_name);
                    
                    // DESCRIPTOGRAFIA SEGURA (VAULT)
                    let decryptedJwtSecret = receiver.jwt_secret;
                    if (decryptedJwtSecret && decryptedJwtSecret.startsWith('vault:')) {
                        try {
                            const vault = VaultService.getInstance();
                            decryptedJwtSecret = await vault.decrypt('cascata-system-keys', decryptedJwtSecret);
                        } catch (e) {
                            console.error(`[WebhookController] Failed to decrypt JWT secret for ${projectSlug}:`, (e as Error).message);
                        }
                    }
                    AutomationService.dispatchAsyncTrigger(
                        receiver.target_id,
                        projectSlug,
                        autoRes.rows[0].nodes,
                        payload,
                        {
                            vars: {},
                            payload, // FIXED: Added missing payload property
                            projectSlug,
                            jwtSecret: decryptedJwtSecret,
                            projectPool
                        }
                    );
                }
            } else if (receiver.target_type === 'TABLE') {
                // Future: Simple direct insert mode
                console.log(`[WebhookReceiver] Target TABLE not yet implemented. Receiver: ${receiver.id}`);
            }

            res.json({ success: true, message: 'Event received and processing.' });

        } catch (e: any) {
            console.error('[WebhookReceiver] Error:', e.message);
            res.status(500).json({ error: 'Internal failure processing incoming webhook.' });
        }
    }
}
