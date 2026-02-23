
import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { PushService } from '../../services/PushService.js';
import { systemPool } from '../config/main.js';

export class PushController {

    // Registra o device do usuário atual (Autenticado)
    static async registerDevice(req: CascataRequest, res: any, next: any) {
        if (!req.user || !req.user.sub) {
            return res.status(401).json({ error: 'User must be authenticated to register a device.' });
        }
        
        const { token, platform, app_version } = req.body;
        if (!token) return res.status(400).json({ error: 'FCM Token is required.' });

        try {
            await PushService.registerDevice(
                req.projectPool!, 
                req.user.sub, 
                token, 
                platform, 
                app_version
            );
            res.json({ success: true });
        } catch (e: any) {
            next(e);
        }
    }

    // Envia Push Manual (Via API/RPC)
    static async sendPush(req: CascataRequest, res: any, next: any) {
        // Requer Service Role ou lógica customizada de segurança
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: 'Only service_role can send arbitrary pushes.' });
        }

        const { user_id, title, body, data } = req.body;
        if (!user_id || !title || !body) return res.status(400).json({ error: 'user_id, title and body are required.' });

        try {
            // Assume que o usuário salvou o JSON do Firebase no metadata do projeto
            const firebaseConfig = req.project.metadata?.firebase_config;

            if (!firebaseConfig) {
                return res.status(400).json({ error: 'Firebase not configured in Project Settings.' });
            }

            const result = await PushService.sendToUser(
                req.projectPool!,
                systemPool,
                req.project.slug,
                user_id,
                { title, body, data },
                {
                    project_id: firebaseConfig.project_id,
                    client_email: firebaseConfig.client_email,
                    private_key: firebaseConfig.private_key
                }
            );

            res.json(result);
        } catch (e: any) {
            next(e);
        }
    }

    // CRUD de Regras (Admin Dashboard)
    static async listRules(req: CascataRequest, res: any, next: any) {
        try {
            const result = await systemPool.query(
                `SELECT * FROM system.notification_rules WHERE project_slug = $1 ORDER BY created_at DESC`,
                [req.project.slug]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async createRule(req: CascataRequest, res: any, next: any) {
        const { name, trigger_table, trigger_event, recipient_column, title_template, body_template, conditions } = req.body;
        try {
            const result = await systemPool.query(
                `INSERT INTO system.notification_rules 
                (project_slug, name, trigger_table, trigger_event, recipient_column, title_template, body_template, conditions)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [req.project.slug, name, trigger_table, trigger_event, recipient_column, title_template, body_template, JSON.stringify(conditions || [])]
            );
            res.json(result.rows[0]);
        } catch (e: any) { next(e); }
    }

    static async deleteRule(req: CascataRequest, res: any, next: any) {
        try {
            await systemPool.query(`DELETE FROM system.notification_rules WHERE id = $1 AND project_slug = $2`, [req.params.id, req.project.slug]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    // LIST HISTORY (Auditoria)
    static async listHistory(req: CascataRequest, res: any, next: any) {
        try {
            const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
            const result = await systemPool.query(
                `SELECT * FROM system.notification_history WHERE project_slug = $1 ORDER BY created_at DESC LIMIT $2`,
                [req.project.slug, limit]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }
}
