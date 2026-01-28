
import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool, SYS_SECRET } from '../config/main.js';

export class SecretsController {
    
    static async list(req: CascataRequest, res: any, next: any) {
        const { slug } = req.params;
        const parentId = req.query.parentId === 'root' ? null : req.query.parentId;
        
        try {
            // Retorna apenas metadados, NUNCA o valor decriptado na listagem
            const result = await systemPool.query(`
                SELECT id, name, type, description, metadata, created_at, updated_at,
                (SELECT COUNT(*) FROM system.project_secrets c WHERE c.parent_id = s.id) as children_count
                FROM system.project_secrets s
                WHERE project_slug = $1 
                AND (($2::uuid IS NULL AND parent_id IS NULL) OR (parent_id = $2::uuid))
                ORDER BY type DESC, name ASC
            `, [slug, parentId]);
            
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async create(req: CascataRequest, res: any, next: any) {
        const { slug } = req.params;
        const { name, type, parent_id, value, description, metadata } = req.body;
        
        const safeParentId = (parent_id === 'root' || !parent_id) ? null : parent_id;

        try {
            let query = '';
            let params = [];

            if (type === 'folder') {
                query = `
                    INSERT INTO system.project_secrets (project_slug, parent_id, name, type, description)
                    VALUES ($1, $2, $3, 'folder', $4)
                    RETURNING id, name, type
                `;
                params = [slug, safeParentId, name, description];
            } else {
                // Criptografa o valor usando PGP nativo do Postgres usando a SYSTEM_JWT_SECRET como chave
                query = `
                    INSERT INTO system.project_secrets (project_slug, parent_id, name, type, description, secret_value, metadata)
                    VALUES ($1, $2, $3, $4, $5, pgp_sym_encrypt($6, $7), $8)
                    RETURNING id, name, type
                `;
                params = [slug, safeParentId, name, type, description, value, SYS_SECRET, JSON.stringify(metadata || {})];
            }

            const result = await systemPool.query(query, params);
            
            // Log de Auditoria de Criação
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            await systemPool.query(
                `INSERT INTO system.api_logs (project_slug, method, path, status_code, client_ip, duration_ms, user_role, payload, geo_info) 
                 VALUES ($1, 'VAULT_CREATE', 'secrets', 201, $2, 0, 'admin', $3, '{"action": "SECRET_CREATED"}')`,
                [slug, String(ip), JSON.stringify({ name, type })]
            );

            res.json(result.rows[0]);
        } catch (e: any) { 
            if (e.code === '23505') return res.status(400).json({ error: "Já existe um item com este nome nesta pasta." });
            next(e); 
        }
    }

    static async reveal(req: CascataRequest, res: any, next: any) {
        const { slug, id } = req.params;
        
        try {
            // 1. Busca e Decripta
            const result = await systemPool.query(`
                SELECT name, type, metadata, pg_sym_decrypt(secret_value::bytea, $3) as decrypted_value
                FROM system.project_secrets
                WHERE id = $1 AND project_slug = $2
            `, [id, slug, SYS_SECRET]);

            if (result.rows.length === 0) return res.status(404).json({ error: "Secret not found" });
            
            const secret = result.rows[0];

            // 2. AUDITORIA DE SEGURANÇA (CRÍTICO)
            // Registra quem viu, quando e qual segredo. Isso cria rastreabilidade.
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            await systemPool.query(
                `INSERT INTO system.api_logs (project_slug, method, path, status_code, client_ip, duration_ms, user_role, payload, geo_info) 
                 VALUES ($1, 'VAULT_REVEAL', $2, 200, $3, 0, 'admin', $4, '{"action": "SECRET_REVEALED", "severity": "HIGH"}')`,
                [slug, `secrets/${id}/reveal`, String(ip), JSON.stringify({ secret_id: id, secret_name: secret.name })]
            );
            
            res.json({ 
                value: secret.decrypted_value,
                meta: secret.metadata 
            });
        } catch (e: any) { next(e); }
    }

    static async delete(req: CascataRequest, res: any, next: any) {
        const { slug, id } = req.params;
        try {
            await systemPool.query(`DELETE FROM system.project_secrets WHERE id = $1 AND project_slug = $2`, [id, slug]);
            
            // Log de Auditoria de Deleção
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            await systemPool.query(
                `INSERT INTO system.api_logs (project_slug, method, path, status_code, client_ip, duration_ms, user_role, payload, geo_info) 
                 VALUES ($1, 'VAULT_DELETE', $2, 200, $3, 0, 'admin', '{}', '{"action": "SECRET_DELETED"}')`,
                [slug, `secrets/${id}`, String(ip)]
            );

            res.json({ success: true });
        } catch (e: any) { next(e); }
    }
}
