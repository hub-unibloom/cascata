
import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { RateLimitService } from '../../services/RateLimitService.js';
import { quoteId } from '../utils/index.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

export class SecurityController {
    
    static async getStatus(req: CascataRequest, res: any, next: any) {
        try { 
            const panicMode = await RateLimitService.checkPanic(req.project.slug); 
            const currentRps = await RateLimitService.getCurrentRPS(req.project.slug);
            res.json({ current_rps: currentRps, panic_mode: panicMode }); 
        } catch (e: any) { next(e); }
    }

    static async togglePanic(req: CascataRequest, res: any, next: any) {
        try { 
            await RateLimitService.setPanic(req.project.slug, req.body.enabled); 
            await systemPool.query("UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{security,panic_mode}', $1) WHERE slug = $2", [JSON.stringify(req.body.enabled), req.project.slug]); 
            res.json({ success: true, panic_mode: req.body.enabled }); 
        } catch (e: any) { next(e); }
    }

    // --- RATE LIMITS (GLOBAL RULES) ---
    static async listRateLimits(req: CascataRequest, res: any, next: any) {
        try { const result = await systemPool.query('SELECT * FROM system.rate_limits WHERE project_slug = $1 ORDER BY created_at DESC', [req.project.slug]); res.json(result.rows); } catch (e: any) { next(e); }
    }

    static async createRateLimit(req: CascataRequest, res: any, next: any) {
        const { 
            route_pattern, method, window_seconds, message_anon, message_auth,
            rate_limit_anon, burst_limit_anon, 
            rate_limit_auth, burst_limit_auth,
            crud_limits, group_limits 
        } = req.body;
        
        // Fallback for legacy fields
        const rateAnon = rate_limit_anon || req.body.rate_limit || 10;
        const burstAnon = burst_limit_anon || req.body.burst_limit || 5;
        const rateAuth = rate_limit_auth || (rateAnon * 2);
        const burstAuth = burst_limit_auth || (burstAnon * 2);

        try { 
            const result = await systemPool.query(`
                INSERT INTO system.rate_limits 
                (project_slug, route_pattern, method, 
                 rate_limit, burst_limit, 
                 rate_limit_anon, burst_limit_anon, 
                 rate_limit_auth, burst_limit_auth, 
                 window_seconds, message_anon, message_auth, crud_limits, group_limits) 
                VALUES ($1, $2, $3, $4, $5, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
                ON CONFLICT (project_slug, route_pattern, method) 
                DO UPDATE SET 
                    rate_limit_anon = EXCLUDED.rate_limit_anon, 
                    burst_limit_anon = EXCLUDED.burst_limit_anon, 
                    rate_limit_auth = EXCLUDED.rate_limit_auth, 
                    burst_limit_auth = EXCLUDED.burst_limit_auth, 
                    window_seconds = EXCLUDED.window_seconds, 
                    message_anon = EXCLUDED.message_anon, 
                    message_auth = EXCLUDED.message_auth, 
                    crud_limits = EXCLUDED.crud_limits,
                    group_limits = EXCLUDED.group_limits,
                    updated_at = NOW() 
                RETURNING *`, 
                [req.project.slug, route_pattern, method, rateAnon, burstAnon, rateAuth, burstAuth, window_seconds || 1, message_anon, message_auth, crud_limits || {}, group_limits || {}]
            ); 
            RateLimitService.clearRules(req.project.slug); 
            res.json(result.rows[0]); 
        } catch (e: any) { next(e); }
    }

    static async deleteRateLimit(req: CascataRequest, res: any, next: any) {
        try { 
            await systemPool.query('DELETE FROM system.rate_limits WHERE id = $1 AND project_slug = $2', [req.params.id, req.project.slug]); 
            RateLimitService.clearRules(req.project.slug); 
            res.json({ success: true }); 
        } catch (e: any) { next(e); }
    }

    // --- KEY GROUPS (PLANS) ---
    static async listKeyGroups(req: CascataRequest, res: any, next: any) {
        try {
            const result = await systemPool.query(
                `SELECT * FROM system.api_key_groups WHERE project_slug = $1 ORDER BY name ASC`,
                [req.project.slug]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async createKeyGroup(req: CascataRequest, res: any, next: any) {
        const { name, rate_limit, burst_limit, window_seconds, rejection_message, nerf_config, crud_limits, scopes } = req.body;
        try {
            const result = await systemPool.query(`
                INSERT INTO system.api_key_groups 
                (project_slug, name, rate_limit, burst_limit, window_seconds, rejection_message, nerf_config, crud_limits, scopes)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *
            `, [req.project.slug, name, rate_limit || 100, burst_limit || 50, window_seconds || 1, rejection_message, nerf_config || { enabled: false }, crud_limits || {}, scopes || []]);
            res.json(result.rows[0]);
        } catch (e: any) { next(e); }
    }

    static async updateKeyGroup(req: CascataRequest, res: any, next: any) {
        const { name, rate_limit, burst_limit, window_seconds, rejection_message, nerf_config } = req.body;
        const { id } = req.params;
        try {
            const result = await systemPool.query(`
                UPDATE system.api_key_groups 
                SET name = $1, rate_limit = $2, burst_limit = $3, window_seconds = $4, rejection_message = $5, nerf_config = $6, updated_at = NOW()
                WHERE id = $7 AND project_slug = $8
                RETURNING *
            `, [name, rate_limit, burst_limit, window_seconds, rejection_message, nerf_config, id, req.project.slug]);
            
            if (result.rows.length === 0) return res.status(404).json({ error: "Group not found" });
            
            RateLimitService.invalidateGroup(id);
            res.json(result.rows[0]);
        } catch (e: any) { next(e); }
    }

    static async deleteKeyGroup(req: CascataRequest, res: any, next: any) {
        try {
            const check = await systemPool.query('SELECT COUNT(*) FROM system.api_keys WHERE group_id = $1', [req.params.id]);
            if (parseInt(check.rows[0].count) > 0) {
                return res.status(400).json({ error: "Cannot delete group: it has active keys." });
            }
            await systemPool.query('DELETE FROM system.api_key_groups WHERE id = $1 AND project_slug = $2', [req.params.id, req.project.slug]);
            RateLimitService.invalidateGroup(req.params.id);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    // --- CUSTOM API KEYS ---
    static async listApiKeys(req: CascataRequest, res: any, next: any) {
        try {
            const result = await systemPool.query(
                `SELECT k.id, k.name, k.prefix, k.scopes, k.rate_limit, k.burst_limit, k.expires_at, k.last_used_at, k.is_active, k.created_at, k.group_id, g.name as group_name
                 FROM system.api_keys k
                 LEFT JOIN system.api_key_groups g ON k.group_id = g.id
                 WHERE k.project_slug = $1 
                 ORDER BY k.created_at DESC`,
                [req.project.slug]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async createApiKey(req: CascataRequest, res: any, next: any) {
        const { name, scopes, rate_limit, burst_limit, expires_in_days, group_id } = req.body;
        if (!name) return res.status(400).json({ error: "Name is required" });

        try {
            // SECURE GENERATION: sk_live_UUID_RANDOM
            const uuid = crypto.randomUUID().replace(/-/g, '');
            const random = crypto.randomBytes(12).toString('hex');
            
            const rawKey = `sk_live_${uuid}_${random}`;
            const lookupIndex = `sk_live_${uuid}`; // Safe non-secret part for lookup
            
            // Hash the FULL raw key
            const hashedKey = await bcrypt.hash(rawKey, 10);
            
            let expiresAt = null;
            if (expires_in_days) {
                expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + parseInt(expires_in_days));
            }
            
            const result = await systemPool.query(`
                INSERT INTO system.api_keys 
                (project_slug, name, key_hash, lookup_index, prefix, scopes, rate_limit, burst_limit, expires_at, group_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING id, name, prefix, scopes, rate_limit, burst_limit, expires_at, created_at, group_id
            `, [req.project.slug, name, hashedKey, lookupIndex, 'sk_live_', scopes || ['*'], rate_limit, burst_limit, expiresAt, group_id || null]);

            // Return the RAW key once. The DB only has the hash.
            res.json({ ...result.rows[0], secret: rawKey });
        } catch (e: any) { next(e); }
    }

    static async updateApiKey(req: CascataRequest, res: any, next: any) {
        const { expires_at, is_active } = req.body;
        try {
            let updates = [];
            let values = [];
            let idx = 1;
            if (expires_at !== undefined) { updates.push(`expires_at = $${idx++}`); values.push(expires_at); }
            if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); values.push(is_active); }
            
            if (updates.length === 0) return res.json({ success: true });
            
            values.push(req.params.id);
            values.push(req.project.slug);
            
            await systemPool.query(
                `UPDATE system.api_keys SET ${updates.join(', ')} WHERE id = $${idx++} AND project_slug = $${idx++}`,
                values
            );
            res.json({ success: true });
        } catch(e: any) { next(e); }
    }

    static async migrateApiKey(req: CascataRequest, res: any, next: any) {
        const { password, group_id } = req.body;
        
        try {
            // 1. Verify Admin Password
            const admin = (await systemPool.query('SELECT password_hash FROM system.admin_users LIMIT 1')).rows[0];
            const isValid = await bcrypt.compare(password, admin.password_hash);
            if (!isValid) return res.status(401).json({ error: "Invalid password" });

            // 2. Update Group
            await systemPool.query(
                `UPDATE system.api_keys SET group_id = $1 WHERE id = $2 AND project_slug = $3`,
                [group_id, req.params.id, req.project.slug]
            );
            
            res.json({ success: true });
        } catch(e: any) { next(e); }
    }

    static async deleteApiKey(req: CascataRequest, res: any, next: any) {
        try {
            await systemPool.query('DELETE FROM system.api_keys WHERE id = $1 AND project_slug = $2', [req.params.id, req.project.slug]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    // --- RLS POLICIES ---
    static async listPolicies(req: CascataRequest, res: any, next: any) {
        try { const result = await req.projectPool!.query("SELECT * FROM pg_policies"); res.json(result.rows); } catch (e: any) { next(e); }
    }

    static async createPolicy(req: CascataRequest, res: any, next: any) {
        const { name, table, command, role, using, withCheck } = req.body;
        try { 
            await req.projectPool!.query(`CREATE POLICY ${quoteId(name)} ON public.${quoteId(table)} FOR ${command} TO ${role} USING (${using}) ${withCheck ? `WITH CHECK (${withCheck})` : ''}`); 
            res.json({ success: true }); 
        } catch (e: any) { next(e); }
    }

    static async deletePolicy(req: CascataRequest, res: any, next: any) {
        try { await req.projectPool!.query(`DROP POLICY ${quoteId(req.params.name)} ON public.${quoteId(req.params.table)}`); res.json({ success: true }); } catch (e: any) { next(e); }
    }

    // --- LOGS ---
    static async getLogs(req: CascataRequest, res: any, next: any) {
        try { const result = await systemPool.query('SELECT * FROM system.api_logs WHERE project_slug = $1 ORDER BY created_at DESC LIMIT 100', [req.project.slug]); res.json(result.rows); } catch (e: any) { next(e); }
    }
}
