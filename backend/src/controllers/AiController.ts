import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { AiService } from '../../services/AiService.js';
import { OpenApiService } from '../../services/OpenApiService.js';

export class AiController {
    // Fix: Use any for next parameter to resolve callable signature issues
    static async listSessions(req: CascataRequest, res: any, next: any) {
        try {
            const result = await systemPool.query(
                `SELECT * FROM system.ai_sessions WHERE project_slug = $1 ORDER BY updated_at DESC`,
                [req.project.slug]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    // Fix: Use any for next parameter to resolve callable signature issues
    static async updateSession(req: CascataRequest, res: any, next: any) {
        try {
            await systemPool.query(
                `UPDATE system.ai_sessions SET title = $1, updated_at = NOW() WHERE id = $2 AND project_slug = $3`,
                [req.body.title, req.params.id, req.project.slug]
            );
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    // Fix: Use any for next parameter to resolve callable signature issues
    static async searchSessions(req: CascataRequest, res: any, next: any) {
        const { query } = req.body;
        if (!query) return res.json([]);
        try {
            const result = await systemPool.query(
                `SELECT DISTINCT s.id, s.title, s.updated_at 
                 FROM system.ai_history h
                 JOIN system.ai_sessions s ON s.id::text = h.session_id
                 WHERE h.project_slug = $1 
                 AND h.content ILIKE $2
                 ORDER BY s.updated_at DESC
                 LIMIT 10`,
                [req.project.slug, `%${query}%`]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    // Fix: Use any for next parameter to resolve callable signature issues
    static async chat(req: CascataRequest, res: any, next: any) {
        try {
            const settingsRes = await systemPool.query("SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const { session_id, messages } = req.body;
            
            if (session_id) {
                await systemPool.query(
                    `INSERT INTO system.ai_sessions (id, project_slug, title) 
                     VALUES ($1, $2, 'Nova Conversa') 
                     ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
                    [session_id, req.project.slug]
                ).catch(() => {});
            }

            const response = await AiService.chat(req.project.slug, req.projectPool!, settingsRes.rows[0]?.settings || {}, req.body);
            
            if (session_id && messages?.length > 0) {
                const lastUser = messages[messages.length - 1];
                await systemPool.query(
                    "INSERT INTO system.ai_history (project_slug, session_id, role, content) VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)", 
                    [req.project.slug, session_id, lastUser.content, response.choices[0].message.content]
                ).catch(() => {});
            }
            
            res.json(response);
        } catch (e: any) { next(e); }
    }

    // Fix: Use any for next parameter to resolve callable signature issues
    static async getHistory(req: CascataRequest, res: any, next: any) {
        try { 
            const result = await systemPool.query("SELECT role, content, created_at FROM system.ai_history WHERE project_slug = $1 AND session_id = $2 ORDER BY created_at ASC", [req.project.slug, req.params.session_id]); 
            res.json(result.rows); 
        } catch (e: any) { next(e); }
    }

    // --- UTILS & DOCS ---
    // Fix: Use any for next parameter to resolve callable signature issues
    static async fixSql(req: CascataRequest, res: any, next: any) {
        try {
            const settingsRes = await systemPool.query("SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const fixedSql = await AiService.fixSQL(req.project.slug, req.projectPool!, settingsRes.rows[0]?.settings || {}, req.body.sql, req.body.error);
            res.json({ fixed_sql: fixedSql });
        } catch (e: any) { next(e); }
    }

    // Fix: Use any for next parameter to resolve callable signature issues
    static async explain(req: CascataRequest, res: any, next: any) {
        try {
            const settingsRes = await systemPool.query("SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const result = await AiService.explainCode(req.project.slug, req.projectPool!, settingsRes.rows[0]?.settings || {}, req.body.code, req.body.type || 'sql');
            res.json(result);
        } catch (e: any) { next(e); }
    }

    // Fix: Use any for next parameter to resolve callable signature issues
    static async listDocPages(req: CascataRequest, res: any, next: any) {
        try { const result = await systemPool.query('SELECT * FROM system.doc_pages WHERE project_slug = $1 ORDER BY title ASC', [req.project.slug]); res.json(result.rows); } catch (e: any) { next(e); }
    }

    // Fix: Use any for next parameter to resolve callable signature issues
    static async draftDoc(req: CascataRequest, res: any, next: any) {
        try {
            const settingsRes = await systemPool.query("SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const doc = await AiService.draftDoc(req.project.slug, req.projectPool!, settingsRes.rows[0]?.settings || {}, req.body.tableName);
            const saveRes = await systemPool.query("INSERT INTO system.doc_pages (project_slug, slug, title, content_markdown) VALUES ($1, $2, $3, $4) ON CONFLICT (project_slug, slug) DO UPDATE SET title = EXCLUDED.title, content_markdown = EXCLUDED.content_markdown, updated_at = NOW() RETURNING *", [req.project.slug, doc.id, doc.title, doc.content_markdown]);
            res.json(saveRes.rows[0]);
        } catch (e: any) { next(e); }
    }

    // Fix: Use any for next parameter to resolve callable signature issues
    static async getOpenApiSpec(req: CascataRequest, res: any, next: any) {
        try { 
            // Pass systemPool to enable reading Edge Functions from system tables
            const spec = await OpenApiService.generate(
                req.project.slug, 
                req.project.db_name, 
                req.projectPool!, 
                systemPool,
                req.headers.host || 'localhost'
            ); 
            res.json(spec); 
        } catch (e: any) { next(e); }
    }
}
