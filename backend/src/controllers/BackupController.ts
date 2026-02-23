
import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool, SYS_SECRET, TEMP_UPLOAD_ROOT } from '../config/main.js';
import { QueueService } from '../../services/QueueService.js';
import { GDriveService } from '../../services/GDriveService.js';
import { S3BackupService } from '../../services/S3BackupService.js';
import { ImportService } from '../../services/ImportService.js';
import { CertificateService } from '../../services/CertificateService.js';
import bcrypt from 'bcrypt';
import path from 'path';
import fs from 'fs';

export class BackupController {
    
    static async validateConfig(req: CascataRequest, res: any, next: any) {
        try {
            const { config, provider } = req.body;
            if (!config) return res.status(400).json({ error: "Config missing" });
            
            let result;
            if (provider === 'gdrive') {
                result = await GDriveService.validateConfig(config);
            } else if (['s3', 'b2', 'r2', 'wasabi', 'aws'].includes(provider)) {
                result = await S3BackupService.validateConfig(config);
            } else {
                return res.status(400).json({ error: "Provider desconhecido" });
            }

            if (!result.valid) {
                return res.status(400).json({ error: result.message });
            }
            
            res.json({ success: true, message: result.message });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    }

    static async listPolicies(req: CascataRequest, res: any, next: any) {
        try {
            const result = await systemPool.query(
                `SELECT 
                    id, project_slug, name, provider, schedule_cron, retention_count, is_active, last_run_at, last_status, created_at, updated_at,
                    CASE 
                        WHEN config ? 'encrypted_data' THEN pgp_sym_decrypt(decode(config->>'encrypted_data', 'base64'), $2)
                        ELSE config::text
                    END as config_str
                 FROM system.backup_policies 
                 WHERE project_slug = $1 
                 ORDER BY created_at DESC`,
                [req.params.slug, SYS_SECRET]
            );
            
            const rows = result.rows.map(r => {
                try {
                    return { ...r, config: JSON.parse(r.config_str) };
                } catch (e) {
                    return { ...r, config: {} };
                }
            });

            res.json(rows);
        } catch (e: any) { next(e); }
    }

    static async createPolicy(req: CascataRequest, res: any, next: any) {
        const { name, provider, schedule_cron, config, retention_count } = req.body;
        const slug = req.params.slug;
        
        if (!name || !schedule_cron || !config || !provider) return res.status(400).json({ error: "Missing required fields" });
        
        try {
            const result = await systemPool.query(
                `INSERT INTO system.backup_policies 
                (project_slug, name, provider, schedule_cron, config, retention_count) 
                VALUES (
                    $1, $2, $3, $4, 
                    jsonb_build_object('encrypted_data', encode(pgp_sym_encrypt($5::text, $7), 'base64')), 
                    $6
                ) RETURNING id`,
                [slug, name, provider, schedule_cron, JSON.stringify(config), retention_count || 7, SYS_SECRET]
            );
            
            const policyId = result.rows[0].id;

            // Fetch Project Timezone for Scheduling
            const projectRes = await systemPool.query('SELECT metadata FROM system.projects WHERE slug = $1', [slug]);
            const timezone = projectRes.rows[0]?.metadata?.timezone || 'UTC';

            await QueueService.scheduleBackup(policyId, schedule_cron, timezone);
            
            res.json({ success: true, id: policyId });
        } catch (e: any) { next(e); }
    }

    static async updatePolicy(req: CascataRequest, res: any, next: any) {
        const { id, slug } = req.params;
        const { name, schedule_cron, config, is_active, retention_count } = req.body;

        try {
            const fields = [];
            const values = [];
            let idx = 1;
            
            if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
            if (schedule_cron !== undefined) { fields.push(`schedule_cron = $${idx++}`); values.push(schedule_cron); }
            
            if (config !== undefined) { 
                fields.push(`config = jsonb_build_object('encrypted_data', encode(pgp_sym_encrypt($${idx++}::text, $${idx++}), 'base64'))`); 
                values.push(JSON.stringify(config));
                values.push(SYS_SECRET);
            }
            
            if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(is_active); }
            if (retention_count !== undefined) { fields.push(`retention_count = $${idx++}`); values.push(retention_count); }
            
            if (fields.length === 0) return res.json({ success: true });

            values.push(id);
            values.push(slug);
            const idIdx = values.length - 1;
            const slugIdx = values.length;

            const query = `UPDATE system.backup_policies SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idIdx} AND project_slug = $${slugIdx} RETURNING *`;
            const result = await systemPool.query(query, values);
            
            if (result.rows.length === 0) return res.status(404).json({error: "Policy not found"});
            const policy = result.rows[0];

            if (policy.is_active) {
                const projectRes = await systemPool.query('SELECT metadata FROM system.projects WHERE slug = $1', [slug]);
                const timezone = projectRes.rows[0]?.metadata?.timezone || 'UTC';
                await QueueService.scheduleBackup(policy.id, policy.schedule_cron, timezone);
            } else {
                await QueueService.removeBackupSchedule(policy.id);
            }

            res.json(policy);
        } catch (e: any) { next(e); }
    }

    static async deletePolicy(req: CascataRequest, res: any, next: any) {
        try {
            await QueueService.removeBackupSchedule(req.params.id);
            await systemPool.query(`DELETE FROM system.backup_policies WHERE id = $1 AND project_slug = $2`, [req.params.id, req.params.slug]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async triggerManual(req: CascataRequest, res: any, next: any) {
        try {
            const { id, slug } = req.params;
            const check = await systemPool.query(`SELECT 1 FROM system.backup_policies WHERE id = $1 AND project_slug = $2`, [id, slug]);
            if (check.rowCount === 0) return res.status(404).json({ error: "Policy not found" });

            await QueueService.triggerBackupNow(id);
            res.json({ success: true, message: "Backup job enqueued." });
        } catch (e: any) { next(e); }
    }

    static async getHistory(req: CascataRequest, res: any, next: any) {
        try {
            const result = await systemPool.query(
                `SELECT h.*, p.name as policy_name, p.provider as policy_provider
                 FROM system.backup_history h
                 LEFT JOIN system.backup_policies p ON h.policy_id = p.id
                 WHERE h.project_slug = $1 
                 ORDER BY h.started_at DESC LIMIT 50`,
                [req.params.slug]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async getDownloadLink(req: CascataRequest, res: any, next: any) {
        const { slug, historyId } = req.params;
        try {
            const histRes = await systemPool.query(
                `SELECT h.external_id, h.file_name, p.provider,
                 CASE 
                    WHEN p.config ? 'encrypted_data' THEN pgp_sym_decrypt(decode(p.config->>'encrypted_data', 'base64'), $2)
                    ELSE p.config::text
                 END as config_str
                 FROM system.backup_history h
                 JOIN system.backup_policies p ON h.policy_id = p.id
                 WHERE h.id = $1 AND h.project_slug = $3`,
                [historyId, SYS_SECRET, slug]
            );

            if (histRes.rows.length === 0) return res.status(404).json({ error: "Backup not found" });
            const record = histRes.rows[0];
            const config = JSON.parse(record.config_str);

            let url = '';
            if (record.provider === 'gdrive') {
                 url = `https://drive.google.com/file/d/${record.external_id}/view?usp=sharing`;
            } else {
                url = await S3BackupService.getSignedDownloadUrl(record.external_id, config);
            }
            res.json({ url });
        } catch (e: any) {
            res.status(500).json({ error: "Failed to generate link" });
        }
    }

    static async restoreBackup(req: CascataRequest, res: any, next: any) {
        const { slug, historyId } = req.params;
        const { password } = req.body;
        const tempFile = path.join(TEMP_UPLOAD_ROOT, `restore_${slug}_${Date.now()}.caf`);

        try {
            const adminRes = await systemPool.query('SELECT password_hash FROM system.admin_users LIMIT 1');
            const isValid = await bcrypt.compare(password, adminRes.rows[0].password_hash);
            if (!isValid) return res.status(401).json({ error: "Senha inválida" });

            const histRes = await systemPool.query(
                `SELECT h.external_id, h.file_name, p.provider,
                 CASE 
                    WHEN p.config ? 'encrypted_data' THEN pgp_sym_decrypt(decode(p.config->>'encrypted_data', 'base64'), $2)
                    ELSE p.config::text
                 END as config_str
                 FROM system.backup_history h
                 JOIN system.backup_policies p ON h.policy_id = p.id
                 WHERE h.id = $1 AND h.project_slug = $3`,
                [historyId, SYS_SECRET, slug]
            );

            if (histRes.rows.length === 0) return res.status(404).json({ error: "Backup not found" });
            const record = histRes.rows[0];
            const config = JSON.parse(record.config_str);

            console.log(`[Restore] Downloading backup ${record.external_id} from ${record.provider}...`);
            
            if (record.provider === 'gdrive') {
                await GDriveService.downloadToPath(record.external_id, tempFile, config);
            } else {
                await S3BackupService.downloadToPath(record.external_id, tempFile, config);
            }

            console.log(`[Restore] Applying backup to ${slug}...`);
            await ImportService.restoreProject(tempFile, slug, systemPool, { mode: 'recovery', includeData: true });
            
            // Garantir limpeza
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            
            await CertificateService.rebuildNginxConfigs(systemPool);
            res.json({ success: true, message: "Sistema restaurado com sucesso." });

        } catch (e: any) {
            // Garantir limpeza mesmo em erro
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            console.error("Restore Failed:", e);
            res.status(500).json({ error: "Falha na restauração: " + e.message });
        }
    }
}
