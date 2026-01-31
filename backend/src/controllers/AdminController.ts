
import { NextFunction, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { spawn } from 'child_process';
import { CascataRequest } from '../types.js';
import { systemPool, SYS_SECRET, STORAGE_ROOT, TEMP_UPLOAD_ROOT } from '../config/main.js';
import { DatabaseService } from '../../services/DatabaseService.js';
import { PoolService } from '../../services/PoolService.js';
import { CertificateService } from '../../services/CertificateService.js';
import { BackupService } from '../../services/BackupService.js';
import { ImportService } from '../../services/ImportService.js';
import { WebhookService } from '../../services/WebhookService.js';
import { RealtimeService } from '../../services/RealtimeService.js';
import { RateLimitService } from '../../services/RateLimitService.js';
import { SystemLogService } from '../../services/SystemLogService.js';
import { GDriveService } from '../../services/GDriveService.js';
import { S3BackupService } from '../../services/S3BackupService.js';

const generateKey = () => import('crypto').then(c => c.randomBytes(32).toString('hex'));

export class AdminController {
    
    static async login(req: CascataRequest, res: any, next: any) {
        const { email, password } = req.body;
        try {
            const result = await systemPool.query('SELECT * FROM system.admin_users WHERE email = $1', [email]);
            if (result.rows.length === 0) {
                await bcrypt.compare(password, "$2b$10$abcdefghijklmnopqrstuv"); 
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            const admin = result.rows[0];
            const isValid = await bcrypt.compare(password, admin.password_hash);
            
            if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });
            
            const token = jwt.sign({ role: 'admin', sub: admin.id }, SYS_SECRET, { expiresIn: '12h' });
            
            const isProd = process.env.NODE_ENV === 'production';
            res.cookie('admin_token', token, {
                httpOnly: true,
                secure: isProd,
                sameSite: 'strict',
                maxAge: 12 * 60 * 60 * 1000 
            });

            res.json({ token });
        } catch (e: any) { next(e); }
    }

    static async verify(req: CascataRequest, res: any, next: any) {
        try {
            const user = (await systemPool.query('SELECT * FROM system.admin_users LIMIT 1')).rows[0];
            const isValid = await bcrypt.compare(req.body.password, user.password_hash);
            if (isValid) res.json({ success: true });
            else res.status(401).json({ error: 'Invalid password' });
        } catch (e: any) { next(e); }
    }

    static async updateProfile(req: CascataRequest, res: any, next: any) {
        const { email, password } = req.body;
        try {
            let passwordHash = undefined;
            if (password) passwordHash = await bcrypt.hash(password, 10);
            let query = 'UPDATE system.admin_users SET email = $1';
            const params = [email];
            if (passwordHash) { query += ', password_hash = $2'; params.push(passwordHash); }
            query += ' WHERE id = (SELECT id FROM system.admin_users LIMIT 1)';
            await systemPool.query(query, params);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    // --- SYSTEM OBSERVABILITY ---
    static async getSystemLogs(req: CascataRequest, res: any, next: any) {
        try {
            const logs = await SystemLogService.getLogs(200);
            res.json(logs);
        } catch (e: any) { next(e); }
    }

    static async listProjects(req: CascataRequest, res: any, next: any) {
        try { 
            const result = await systemPool.query(`
                SELECT 
                    id, name, slug, db_name, custom_domain, ssl_certificate_source, blocklist, status, created_at,
                    '******' as jwt_secret, 
                    pgp_sym_decrypt(anon_key::bytea, $1::text) as anon_key, 
                    '******' as service_key,
                    (metadata - 'secrets') as metadata 
                FROM system.projects 
                ORDER BY created_at DESC
            `, [SYS_SECRET]); 
            res.json(result.rows); 
        } catch (e: any) { next(e); }
    }

    static async createProject(req: CascataRequest, res: any, next: any) {
        const { name, slug, timezone } = req.body; 
        const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
        
        const reserved = ['system', 'control', 'api', 'dashboard', 'assets', 'auth', 'health'];
        if (reserved.includes(safeSlug)) {
            return res.status(400).json({ error: "Reserved project slug." });
        }

        const tz = timezone || 'UTC';
        try {
            Intl.DateTimeFormat(undefined, { timeZone: tz });
        } catch (e) {
            return res.status(400).json({ error: `Invalid timezone: ${tz}` });
        }

        const dbName = `cascata_db_${safeSlug.replace(/-/g, '_')}`;
        const qdrantUrl = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;
        
        try {
            const keys = { anon: await generateKey(), service: await generateKey(), jwt: await generateKey() };
            const metadata = { timezone: tz };
            
            const insertRes = await systemPool.query(
                "INSERT INTO system.projects (name, slug, db_name, anon_key, service_key, jwt_secret, metadata) VALUES ($1, $2, $3, pgp_sym_encrypt($4, $7), pgp_sym_encrypt($5, $7), pgp_sym_encrypt($6, $7), $8) RETURNING *", 
                [name, safeSlug, dbName, keys.anon, keys.service, keys.jwt, SYS_SECRET, JSON.stringify(metadata)]
            );
            
            await systemPool.query(`CREATE DATABASE "${dbName}"`);
            const dbHost = process.env.DB_DIRECT_HOST || 'db';
            const dbPort = process.env.DB_DIRECT_PORT || '5432';
            const user = process.env.DB_USER || 'cascata_admin';
            const pass = process.env.DB_PASS || 'secure_pass';
            const tempClient = new pg.Client({ connectionString: `postgresql://${user}:${pass}@${dbHost}:${dbPort}/${dbName}` });
            await tempClient.connect();
            await DatabaseService.initProjectDb(tempClient);
            await tempClient.end();
            try {
                await axios.put(`${qdrantUrl}/collections/${safeSlug}`, { vectors: { size: 1536, distance: 'Cosine' } });
            } catch (qError) { console.error(`[Admin] Qdrant provisioning warning`); }
            await CertificateService.rebuildNginxConfigs(systemPool);
            res.json({ ...insertRes.rows[0], anon_key: keys.anon, service_key: keys.service, jwt_secret: keys.jwt });
        } catch (e: any) { 
            await systemPool.query('DELETE FROM system.projects WHERE slug = $1', [safeSlug]).catch(() => {}); 
            next(e); 
        }
    }

    static async updateProject(req: CascataRequest, res: any, next: any) {
        try {
            const { custom_domain, log_retention_days, metadata, ssl_certificate_source } = req.body;
            
            if (metadata) {
                const keys = JSON.stringify(metadata);
                if (keys.includes('__proto__') || keys.includes('constructor') || keys.includes('prototype')) {
                    return res.status(400).json({ error: "Invalid metadata keys" });
                }
            }

            if (metadata && metadata.external_db_url) {
                const currentProj = (await systemPool.query('SELECT db_name, metadata FROM system.projects WHERE slug = $1', [req.params.slug])).rows[0];
                const oldUrl = currentProj?.metadata?.external_db_url;
                const dbName = currentProj.db_name;
                
                if (metadata.external_db_url !== oldUrl) {
                    console.log(`[Admin] 🚀 Starting SMART MIGRATION for ${req.params.slug}...`);
                    
                    const extClient = new pg.Client({ 
                        connectionString: metadata.external_db_url,
                        ssl: { rejectUnauthorized: false } 
                    });
                    
                    try {
                        await extClient.connect();
                        await DatabaseService.initProjectDb(extClient);
                        await extClient.end();
                    } catch (dbErr: any) {
                        return res.status(400).json({ error: `Connection/Provisioning Failed: ${dbErr.message}` });
                    }

                    const localHost = process.env.DB_DIRECT_HOST || 'db';
                    const localPort = process.env.DB_DIRECT_PORT || '5432';
                    const localUser = process.env.DB_USER || 'cascata_admin';
                    const localPass = process.env.DB_PASS || 'secure_pass';
                    
                    const localConnStr = `postgresql://${localUser}@${localHost}:${localPort}/${dbName}`;

                    // SECURITY FIX: Avoid exposing PGPASSWORD in environment variables
                    const pgPassFile = path.join(TEMP_UPLOAD_ROOT, `.pgpass_${req.params.slug}_${Date.now()}`);
                    const pgPassContent = `${localHost}:${localPort}:${dbName}:${localUser}:${localPass}\n`;
                    fs.writeFileSync(pgPassFile, pgPassContent, { mode: 0o600 });
                    
                    const env = { ...process.env, PGPASSFILE: pgPassFile };

                    console.log(`[Admin] Piping data...`);
                    
                    try {
                        await new Promise<void>((resolve, reject) => {
                            const dumpProc = spawn('pg_dump', [
                                '--dbname', localConnStr,
                                '--no-owner',
                                '--no-acl',
                                '--data-only',
                                '--disable-triggers'
                            ], { env });

                            const restoreProc = spawn('psql', [
                                '--dbname', metadata.external_db_url,
                                '-v', 'ON_ERROR_STOP=1'
                            ]);

                            if (!dumpProc.stdout || !restoreProc.stdin) {
                                dumpProc.kill();
                                restoreProc.kill();
                                reject(new Error("Failed to initialize process streams"));
                                return;
                            }

                            dumpProc.stdout.pipe(restoreProc.stdin);

                            let restoreError = '';
                            restoreProc.stderr.on('data', (d: any) => { restoreError += d.toString(); });

                            restoreProc.on('close', (code: number) => {
                                if (code === 0) resolve();
                                else {
                                    console.error(`[Migration] Restore failed: ${restoreError}`);
                                    reject(new Error(`Restore failed: ${restoreError}`));
                                }
                            });
                        });
                        console.log(`[Admin] ✅ Data Migration Completed Successfully.`);
                    } catch (migrationErr: any) {
                        return res.status(500).json({ error: `Data Migration Failed: ${migrationErr.message}` });
                    } finally {
                        if (fs.existsSync(pgPassFile)) fs.unlinkSync(pgPassFile);
                    }
                }
            }

            const fields = [];
            const values = [];
            let idx = 1;
            if (custom_domain !== undefined) { fields.push(`custom_domain = $${idx++}`); values.push(custom_domain); }
            if (log_retention_days !== undefined) { fields.push(`log_retention_days = $${idx++}`); values.push(log_retention_days); }
            if (ssl_certificate_source !== undefined) { fields.push(`ssl_certificate_source = $${idx++}`); values.push(ssl_certificate_source); }
            
            let metadataUpdate = metadata || {};
            if (metadataUpdate && metadataUpdate.timezone) { delete metadataUpdate.timezone; }

            if (Object.keys(metadataUpdate).length > 0) { 
                fields.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${idx++}::jsonb`); 
                values.push(JSON.stringify(metadataUpdate)); 
            }

            if (fields.length === 0) return res.json({});
            fields.push(`updated_at = now()`);
            values.push(req.params.slug); 
            
            const query = `UPDATE system.projects SET ${fields.join(', ')} WHERE slug = $${idx} RETURNING *`;
            const result = await systemPool.query(query, values);
            const updatedProject = result.rows[0];
            
            await PoolService.reload(updatedProject.db_name);
            RealtimeService.teardownProjectListener(updatedProject.slug);
            await CertificateService.rebuildNginxConfigs(systemPool);
            
            res.json(updatedProject);
        } catch (e: any) { next(e); }
    }

    static async deleteProject(req: CascataRequest, res: any, next: any) {
        const { slug } = req.params;
        const qdrantUrl = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;
        try {
            const project = (await systemPool.query('SELECT * FROM system.projects WHERE slug = $1', [slug])).rows[0];
            if (!project) return res.status(404).json({ error: 'Not found' });
            
            await PoolService.terminate(project.db_name);
            RealtimeService.teardownProjectListener(slug);

            if (!project.metadata?.external_db_url) {
                await systemPool.query(`DROP DATABASE IF EXISTS "${project.db_name}"`);
            }

            await Promise.all(['projects','assets','webhooks','api_logs','ui_settings','rate_limits','doc_pages','ai_history', 'ai_sessions'].map(t => systemPool.query(`DELETE FROM system.${t} WHERE ${t === 'projects' ? 'slug' : 'project_slug'} = $1`, [slug])));
            const storagePath = path.join(STORAGE_ROOT, slug);
            if (fs.existsSync(storagePath)) fs.rmSync(storagePath, { recursive: true, force: true });
            try { await axios.delete(`${qdrantUrl}/collections/${slug}`); } catch (qError) {}
            await CertificateService.rebuildNginxConfigs(systemPool);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async revealKey(req: CascataRequest, res: any, next: any) {
        const { password, keyType } = req.body;
        try {
            const admin = (await systemPool.query('SELECT * FROM system.admin_users LIMIT 1')).rows[0];
            const isValid = await bcrypt.compare(password, admin.password_hash);
            if (!isValid) return res.status(403).json({ error: "Invalid Password" });
            const keyRes = await systemPool.query(`SELECT pgp_sym_decrypt(${keyType}::bytea, $2) as decrypted_key FROM system.projects WHERE slug = $1`, [req.params.slug, SYS_SECRET]);
            res.json({ key: keyRes.rows[0].decrypted_key });
        } catch (e: any) { next(e); }
    }

    static async rotateKeys(req: CascataRequest, res: any, next: any) {
        const { type } = req.body;
        const col = type === 'anon' ? 'anon_key' : type === 'service' ? 'service_key' : 'jwt_secret';
        try { await systemPool.query(`UPDATE system.projects SET ${col} = pgp_sym_encrypt($1, $3) WHERE slug = $2`, [await generateKey(), req.params.slug, SYS_SECRET]); res.json({ success: true }); } catch (e: any) { next(e); }
    }

    static async updateSecrets(req: CascataRequest, res: any, next: any) {
        try {
            await systemPool.query(`UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{secrets}', $1) WHERE slug = $2`, [JSON.stringify(req.body.secrets), req.params.slug]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async blockIp(req: CascataRequest, res: any, next: any) {
        try { await systemPool.query('UPDATE system.projects SET blocklist = array_append(blocklist, $1) WHERE slug = $2', [req.body.ip, req.params.slug]); res.json({ success: true }); } catch (e: any) { next(e); }
    }

    static async unblockIp(req: CascataRequest, res: any, next: any) {
        try { await systemPool.query('UPDATE system.projects SET blocklist = array_remove(blocklist, $1) WHERE slug = $2', [req.params.ip, req.params.slug]); res.json({ success: true }); } catch (e: any) { next(e); }
    }

    static async purgeLogs(req: CascataRequest, res: any, next: any) {
        try { await systemPool.query(`SELECT system.purge_old_logs($1, $2)`, [req.params.slug, Number(req.query.days)]); res.json({ success: true }); } catch (e: any) { next(e); }
    }

    static async exportProject(req: CascataRequest, res: any, next: any) {
        try {
            const project = (await systemPool.query('SELECT * FROM system.projects WHERE slug = $1', [req.params.slug])).rows[0];
            if (!project) return res.status(404).json({ error: 'Project not found' });
            
            const keys = (await systemPool.query(`SELECT pgp_sym_decrypt(jwt_secret::bytea, $2) as jwt_secret, pgp_sym_decrypt(anon_key::bytea, $2) as anon_key, pgp_sym_decrypt(service_key::bytea, $2) as service_key FROM system.projects WHERE slug = $1`, [req.params.slug, SYS_SECRET])).rows[0];
            
            const projectData = { ...project, ...keys };
            await BackupService.streamExport(projectData, res);
        } catch (e: any) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
    }
    
    // NEW: Cloud Export for Logs using Streaming (No Disk)
    static async exportLogsToCloud(req: CascataRequest, res: any, next: any) {
        const { slug } = req.params;
        
        try {
            // 1. Fetch available backup policy to use credentials
            const policyRes = await systemPool.query(
                `SELECT provider, 
                 CASE 
                    WHEN config ? 'encrypted_data' THEN pgp_sym_decrypt(decode(config->>'encrypted_data', 'base64'), $2)
                    ELSE config::text
                 END as config_str
                 FROM system.backup_policies WHERE project_slug = $1 AND is_active = true LIMIT 1`,
                [slug, SYS_SECRET]
            );

            if (policyRes.rows.length === 0) {
                return res.status(400).json({ error: "Nenhuma política de backup configurada. Configure uma para habilitar exportação para nuvem." });
            }

            const policy = policyRes.rows[0];
            const config = JSON.parse(policy.config_str);

            // 2. Obtain Read Stream directly from Database via child process (psql COPY TO STDOUT)
            const logStream = await BackupService.getLogExportStream(slug);
            const fileName = `logs_${slug}_${new Date().toISOString().split('T')[0]}.csv`;
            
            let downloadUrl = '';

            // 3. Pipe stream to Cloud Provider
            if (policy.provider === 'gdrive') {
                const result = await GDriveService.uploadStream(logStream, fileName, 'text/csv', config);
                downloadUrl = result.webViewLink;
            } else if (['s3', 'b2', 'r2', 'wasabi', 'aws'].includes(policy.provider)) {
                const result = await S3BackupService.uploadStream(logStream, fileName, 'text/csv', config);
                // Generate temporary signed URL for immediate download
                downloadUrl = await S3BackupService.getSignedDownloadUrl(result.id, config);
            } else {
                throw new Error(`Provider ${policy.provider} not supported for log export.`);
            }

            res.json({ success: true, url: downloadUrl });

        } catch (e: any) {
            console.error("Log Export Failed", e);
            res.status(500).json({ error: "Falha na exportação de logs: " + e.message });
        }
    }

    static async uploadImport(req: CascataRequest, res: any, next: any) {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        try {
            const manifest = await ImportService.validateBackup(req.file.path);
            res.json({ success: true, manifest, temp_path: req.file.path });
        } catch (e: any) { fs.unlinkSync(req.file.path); res.status(400).json({ error: e.message }); }
    }

    static async confirmImport(req: CascataRequest, res: any, next: any) {
        try {
            const { temp_path, slug, name, mode, include_data } = req.body;
            const result = await ImportService.restoreProject(temp_path, slug, systemPool, { mode: mode || 'recovery', includeData: include_data !== false, nameOverride: name });
            await CertificateService.rebuildNginxConfigs(systemPool);
            res.json(result);
        } catch (e: any) { next(e); }
    }

    static async getSystemSettings(req: CascataRequest, res: any, next: any) {
        try {
            const domainRes = await systemPool.query("SELECT settings->>'domain' as domain FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'domain_config'");
            const aiRes = await systemPool.query("SELECT settings as ai_config FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const dbRes = await systemPool.query("SELECT settings as db_config FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'system_config'");
            res.json({ domain: domainRes.rows[0]?.domain, ai: aiRes.rows[0]?.ai_config, db_config: dbRes.rows[0]?.db_config });
        } catch (e: any) { next(e); }
    }

    static async updateSystemSettings(req: CascataRequest, res: any, next: any) {
        try {
            if (req.body.domain !== undefined) {
                await systemPool.query("INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ('_system_root_', 'domain_config', $1) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1", [JSON.stringify({ domain: req.body.domain })]);
                await CertificateService.rebuildNginxConfigs(systemPool);
            }
            if (req.body.ai_config !== undefined) await systemPool.query("INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ('_system_root_', 'ai_config', $1) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1", [JSON.stringify(req.body.ai_config)]);
            if (req.body.db_config !== undefined) {
                await systemPool.query("INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ('_system_root_', 'system_config', $1) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1", [JSON.stringify(req.body.db_config)]);
                PoolService.configure(req.body.db_config);
            }
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async checkSsl(req: CascataRequest, res: any, next: any) { res.json({ status: 'active' }); }

    static async listCertificates(req: CascataRequest, res: any, next: any) {
        try { res.json({ domains: await CertificateService.listAvailableCerts() }); } catch (e: any) { next(e); }
    }

    static async createCertificate(req: CascataRequest, res: any, next: any) {
        try { res.json(await CertificateService.requestCertificate(req.body.domain, req.body.email, req.body.provider, systemPool, { cert: req.body.cert, key: req.body.key })); } 
        catch (e: any) { res.status(500).json({ error: e.message }); }
    }

    static async deleteCertificate(req: CascataRequest, res: any, next: any) {
        try { await CertificateService.deleteCertificate(req.params.domain, systemPool); res.json({ success: true }); } 
        catch (e: any) { res.status(500).json({ error: e.message }); }
    }

    static async testWebhook(req: CascataRequest, res: any, next: any) {
        try {
            const hook = (await systemPool.query('SELECT * FROM system.webhooks WHERE id = $1', [req.params.id])).rows[0];
            const proj = (await systemPool.query("SELECT pgp_sym_decrypt(jwt_secret::bytea, $1) as jwt_secret FROM system.projects WHERE slug = $2", [SYS_SECRET, hook.project_slug])).rows[0];
            await WebhookService.dispatch(hook.project_slug, hook.table_name, hook.event_type, req.body.payload || { test: true }, systemPool, proj.jwt_secret);
            res.json({ success: true });
        } catch(e: any) { next(e); }
    }
    
    static async listWebhooks(req: CascataRequest, res: any, next: any) {
        try { const result = await systemPool.query('SELECT * FROM system.webhooks WHERE project_slug = $1 ORDER BY created_at DESC', [req.params.slug]); res.json(result.rows); } catch (e: any) { next(e); }
    }

    static async createWebhook(req: CascataRequest, res: any, next: any) {
        try {
            const secret = (await systemPool.query("SELECT pgp_sym_decrypt(jwt_secret::bytea, $1) as jwt_secret FROM system.projects WHERE slug = $2", [SYS_SECRET, req.params.slug])).rows[0].jwt_secret;
            const result = await systemPool.query("INSERT INTO system.webhooks (project_slug, target_url, event_type, table_name, secret_header, filters, fallback_url, retry_policy) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *", [req.params.slug, req.body.target_url, req.body.event_type, req.body.table_name, secret, JSON.stringify(req.body.filters || []), req.body.fallback_url, req.body.retry_policy || 'standard']);
            res.json(result.rows[0]);
        } catch (e: any) { next(e); }
    }

    static async deleteWebhook(req: CascataRequest, res: any, next: any) {
        try { await systemPool.query('DELETE FROM system.webhooks WHERE id = $1 AND project_slug = $2', [req.params.id, req.params.slug]); res.json({ success: true }); } catch (e: any) { next(e); }
    }

    static async updateWebhook(req: CascataRequest, res: any, next: any) {
        try {
            const fields = []; const values = []; let idx = 1;
            const { target_url, event_type, table_name, is_active, filters, fallback_url, retry_policy } = req.body;
            if (target_url !== undefined) { fields.push(`target_url = $${idx++}`); values.push(target_url); }
            if (event_type !== undefined) { fields.push(`event_type = $${idx++}`); values.push(event_type); }
            if (table_name !== undefined) { fields.push(`table_name = $${idx++}`); values.push(table_name); }
            if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(is_active); }
            if (filters !== undefined) { fields.push(`filters = $${idx++}`); values.push(JSON.stringify(filters)); }
            if (fallback_url !== undefined) { fields.push(`fallback_url = $${idx++}`); values.push(fallback_url); }
            if (retry_policy !== undefined) { fields.push(`retry_policy = $${idx++}`); values.push(retry_policy); }
            if (fields.length === 0) return res.json({ success: true });
            values.push(req.params.id); values.push(req.params.slug);
            const query = `UPDATE system.webhooks SET ${fields.join(', ')} WHERE id = $${idx++} AND project_slug = $${idx++} RETURNING *`;
            const result = await systemPool.query(query, values);
            res.json(result.rows[0]);
        } catch (e: any) { next(e); }
    }
}
