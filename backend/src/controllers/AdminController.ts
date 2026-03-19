
import { Request, Response, NextFunction } from 'express';
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
import { VaultService } from '../../services/VaultService.js';
import { CertificateService } from '../../services/CertificateService.js';
import { BackupService } from '../../services/BackupService.js';
import { ImportService } from '../../services/ImportService.js';
import { WebhookService } from '../../services/WebhookService.js';
import { RealtimeService } from '../../services/RealtimeService.js';
import { RateLimitService } from '../../services/RateLimitService.js';
import { SystemLogService } from '../../services/SystemLogService.js';
import { GDriveService } from '../../services/GDriveService.js';
import { S3BackupService } from '../../services/S3BackupService.js';
import { QueueService } from '../../services/QueueService.js';
import { PayloadCrypto } from '../utils/PayloadCrypto.js';

const generateKey = () => import('crypto').then(c => c.randomBytes(32).toString('hex'));

// Handshake session TTL (5 minutos)
const HANDSHAKE_TTL_SECONDS = 300;

export class AdminController {

    // ---------------------------------------------------------------------------
    // HANDSHAKE: Inicia a sessão de criptografia ECDH X25519 efêmera
    // GET /auth/handshake → { sessionId, serverPublicKey }
    // ---------------------------------------------------------------------------
    static async handshake(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            // Gerar par de chaves ECDH X25519 efêmero para este login
            const session = PayloadCrypto.createHandshakeSession();

            // Tentar armazenar no Dragonfly (cache in-memory) com TTL de 5 minutos
            // Fallback: armazena em Map local (processo único — não recomendado para cluster)
            try {
                const RLSvc = (await import('../../services/RateLimitService.js')).RateLimitService;
                const dfly = (RLSvc as any).dragonfly;
                if (dfly) {
                    await dfly.set(
                        `cascata_hs:${session.sessionId}`,
                        JSON.stringify(session),
                        'EX', HANDSHAKE_TTL_SECONDS
                    );
                } else {
                    if (AdminController.handshakeFallbackStore.size > 2000) {
                        const firstKey = AdminController.handshakeFallbackStore.keys().next().value;
                        if (firstKey) AdminController.handshakeFallbackStore.delete(firstKey);
                    }
                    AdminController.handshakeFallbackStore.set(session.sessionId, session);
                    // TTL manual (fallback)
                    setTimeout(() => AdminController.handshakeFallbackStore.delete(session.sessionId), HANDSHAKE_TTL_SECONDS * 1000);
                }
            } catch (err: unknown) {
                if (AdminController.handshakeFallbackStore.size > 2000) {
                    const firstKey = AdminController.handshakeFallbackStore.keys().next().value;
                    if (firstKey) AdminController.handshakeFallbackStore.delete(firstKey);
                }
                AdminController.handshakeFallbackStore.set(session.sessionId, session);
                setTimeout(() => AdminController.handshakeFallbackStore.delete(session.sessionId), HANDSHAKE_TTL_SECONDS * 1000);
            }

            // Retorna a chave pública e a assinatura do servidor
            res.json({
                sessionId:         session.sessionId,
                serverPublicKey:   session.serverPublicKey,
                serverFingerprint: PayloadCrypto.getServerFingerprint(),
            });
        } catch (e: unknown) { next(e); }
    }

    // Fallback store em memória para quando Dragonfly não está disponível
    private static handshakeFallbackStore = new Map<string, any>();

    // ---------------------------------------------------------------------------
    // LOGIN: Suporta payload cifrado (ECDH+AES-GCM) e texto puro (retrocompatível)
    // POST /auth/login
    // ---------------------------------------------------------------------------
    static async login(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        try {
            const body = req.body as { v?: string; ciphertext?: string; sessionId?: string; email?: string; password?: string; otp_code?: string; clientPublicKey?: string }; 
            let email: string;
            let password: string;
            let parsedOtpCode: string = '';
            let isEncrypted = false;
            let sharedKey: Buffer | null = null;

            // ── DETECTOR DE PROTOCOLO ────────────────────────────────────────────
            if (body?.v && body?.ciphertext && body?.sessionId) {
                isEncrypted = true;
                const encPayload = body as { v: string; ciphertext: string; sessionId: string; clientPublicKey: string };

                // 1. Recuperar sessão de handshake
                let session: { serverPrivateKey: string; serverPublicKey: string; sharedKey?: Buffer } | null = null;
                try {
                    const RLSvc = (await import('../../services/RateLimitService.js')).RateLimitService;
                    const dfly = (RLSvc as any).dragonfly;
                    if (dfly) {
                        const raw = await dfly.get(`cascata_hs:${encPayload.sessionId}`);
                        if (raw) {
                            session = JSON.parse(raw);
                            // Destruir sessão imediatamente (one-time use)
                            await dfly.del(`cascata_hs:${encPayload.sessionId}`);
                        }
                    }
                } catch { /* Dragonfly não disponível */ }

                // Fallback store
                if (!session) {
                    session = AdminController.handshakeFallbackStore.get(encPayload.sessionId);
                    if (session) AdminController.handshakeFallbackStore.delete(encPayload.sessionId);
                }

                if (!session) {
                    return res.status(401).json({ error: 'Handshake session expired or invalid.' });
                }

                // 2. Derivar chave compartilhada ECDH
                sharedKey = PayloadCrypto.deriveSharedKey(
                    session.serverPrivateKey as string,
                    encPayload.clientPublicKey
                );

                // 3. Decifrar payload (inclui validação anti-replay de timestamp)
                let plainBody: Record<string, unknown>;
                try {
                    // SAFETY: encPayload is verified to have required fields by the cast above.
                    // Using unknown cast instead of any for the parameter.
                    // Buffer name might not be globally available yet.
                    plainBody = PayloadCrypto.decryptPayload(encPayload as unknown as any, sharedKey as any);
                } catch (e: unknown) {
                    console.warn('[AdminController] Payload decryption failed:', (e as Error).message);
                    return res.status(401).json({ error: 'Invalid or tampered payload.' });
                }

                email         = String(plainBody.email    || '');
                password      = String(plainBody.password || '');
                parsedOtpCode = String(plainBody.otp_code || '');

            } else {
                // ── MODO LEGADO (texto puro): Aceito mas registrado como aviso ──
                console.warn('[AdminController] Login with unencrypted payload detected. Upgrade to secure handshake flow.');
                email         = String(body?.email    || '');
                password      = String(body?.password || '');
                parsedOtpCode = String(body?.otp_code || '');
            }

            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password are required.' });
            }

            // ── VERIFICAÇÃO DAS CREDENCIAIS ──────────────────────────────────────
            const result = await systemPool.query(
                'SELECT * FROM system.admin_users WHERE email = $1', [email]
            );

            if (result.rows.length === 0) {
                // Timing attack mitigation: executar bcrypt mesmo sem usuário
                await bcrypt.compare(password, '$2b$10$abcdefghijklmnopqrstuuvwx');
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const admin = result.rows[0];
            const isValid = await bcrypt.compare(password, admin.password_hash as string);
            if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

            // ── OTP / TOTP VALIDATION (SE CONFIGURADO) ───────────────────────────
            const otpSecret = process.env.CASCATA_OTP_SECRET;
            if (otpSecret) {
                // Se tem segredo OTP, o campo otp_code é obrigatório
                let otpCode: string | undefined = parsedOtpCode;

                // Se o payload foi cifrado, o OTP veio dentro do payload decifrado
                // (tratado acima como parte do plainBody)
                if (!otpCode || otpCode === 'undefined') {
                    return res.status(401).json({
                        error: 'OTP code required.',
                        otp_required: true
                    });
                }

                // Decodificar o segredo OTP se foi salvo cifrado
                let decodedSecret = otpSecret;
                try {
                    // Tenta decifrar via openssl (se foi cifrado no install.sh)
                    const ctrlSecret = process.env.INTERNAL_CTRL_SECRET || '';
                    if (ctrlSecret && otpSecret.includes('=')) {
                        // Base64 detectado — pode estar cifrado. Tenta descriptografar.
                        // Se falhar, usa o valor bruto (pode ser base32 direto)
                        const { execSync } = await import('child_process');
                        try {
                            decodedSecret = execSync(
                                `echo '${otpSecret}' | openssl enc -aes-256-cbc -pbkdf2 -d -pass pass:${ctrlSecret} -base64 -A 2>/dev/null`,
                                { encoding: 'utf8', timeout: 2000 }
                            ).trim();
                        } catch { decodedSecret = otpSecret; }
                    }
                } catch { decodedSecret = otpSecret; }

                const isOtpValid = PayloadCrypto.validateTOTP(decodedSecret, otpCode);
                if (!isOtpValid) {
                    return res.status(401).json({ error: 'Invalid OTP code.' });
                }
            }

            // ── EMISSÃO DO TOKEN ─────────────────────────────────────────────────
            const token = jwt.sign(
                { role: 'admin', sub: admin.id },
                SYS_SECRET,
                { expiresIn: '12h' }
            );

            const isProd = process.env.NODE_ENV === 'production';
            res.cookie('admin_token', token, {
                httpOnly: true,
                secure: isProd,
                sameSite: 'strict',
                maxAge: 12 * 60 * 60 * 1000
            });

            // ── RESPOSTA: CIFRADA (protocolo seguro) ou TEXTO PURO (legado) ──────
            if (isEncrypted && sharedKey) {
                // Cifra a resposta com a mesma sharedKey derivada no handshake
                // Apenas o frontend desta sessão consegue decifrar
                const encResponse = PayloadCrypto.encryptResponse({ token }, sharedKey);
                return res.json(encResponse);
            } else {
                return res.json({ token });
            }

        } catch (e: unknown) { next(e); }
    }

    static async verify(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        try {
            const body = req.body as { password?: string };
            if (!body.password) return res.status(400).json({ error: 'Password required' });
            const user = (await systemPool.query('SELECT password_hash FROM system.admin_users LIMIT 1')).rows[0];
            const isValid = await bcrypt.compare(body.password, user.password_hash as string);
            if (isValid) res.json({ success: true });
            else res.status(401).json({ error: 'Invalid password' });
        } catch (e: unknown) { next(e); }
    }

    static async updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { email, password } = req.body as { email: string; password?: string };
        try {
            let passwordHash: string | undefined = undefined;
            if (password) passwordHash = await bcrypt.hash(password, 10);
            let query = 'UPDATE system.admin_users SET email = $1';
            const params: string[] = [email];
            if (passwordHash) { query += ', password_hash = $2'; params.push(passwordHash); }
            query += ' WHERE id = (SELECT id FROM system.admin_users LIMIT 1)';
            await systemPool.query(query, params);
            res.json({ success: true });
        } catch (e: unknown) { next(e); }
    }

    // ... (System & Project Listing methods remain unchanged) ...
    static async getSystemLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
        try { 
            const logs = await SystemLogService.getLogs(200); 
            res.json(logs); 
        } catch (e: unknown) { next(e); }
    }

    static async listProjects(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await systemPool.query(`
                SELECT id, name, slug, db_name, custom_domain, ssl_certificate_source, blocklist, status, created_at, 
                       '******' as jwt_secret, anon_key, '******' as service_key, (metadata - 'secrets') as metadata 
                FROM system.projects 
                ORDER BY created_at DESC
            `);
            
            const vault = VaultService.getInstance();
            const projects = result.rows as any[];

            for (const project of projects) {
                if (project.anon_key && typeof project.anon_key === 'string' && project.anon_key.startsWith('vault:')) {
                    try {
                        project.anon_key = await vault.decrypt('cascata-system-keys', project.anon_key);
                    } catch (e: unknown) {
                        project.anon_key = '(decrypt-error)';
                    }
                }
            }

            res.json(projects);
        } catch (e: unknown) { next(e); }
    }

    static async createProject(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { name, slug, timezone, custom_domain } = req.body as { name: string; slug: string; timezone?: string; custom_domain?: string };

        // Comprehensive Payload Validation
        if (!name || !slug) {
            return res.status(400).json({ error: "Name and Slug are strictly required." });
        }

        if (slug.length < 3 || slug.length > 50) {
            return res.status(400).json({ error: "Slug must be between 3 and 50 characters." });
        }

        const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
        const reserved = ['system', 'control', 'api', 'dashboard', 'assets', 'auth', 'health'];
        if (reserved.includes(safeSlug)) return res.status(400).json({ error: "Reserved project slug." });

        const dbName = `cascata_db_${safeSlug.replace(/-/g, '_')}`;

        try {
            const keys = { anon: await generateKey(), service: await generateKey(), jwt: await generateKey() };
            const vault = VaultService.getInstance();
            const encryptedKeys = {
                anon: await vault.encrypt('cascata-system-keys', keys.anon),
                service: await vault.encrypt('cascata-system-keys', keys.service),
                jwt: await vault.encrypt('cascata-system-keys', keys.jwt)
            };

            const insertRes = await systemPool.query(
                "INSERT INTO system.projects (name, slug, db_name, anon_key, service_key, jwt_secret, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
                [name, safeSlug, dbName, encryptedKeys.anon, encryptedKeys.service, encryptedKeys.jwt, JSON.stringify({ timezone: timezone || 'UTC' })]
            );
            await systemPool.query(`CREATE DATABASE "${dbName}"`);

            // FIX: Enforce Temporal Consistency by natively linking the DB to the requested Timezone
            const tz = timezone || process.env.GENERIC_TIMEZONE || 'UTC';
            const safeTz = tz.replace(/[^a-zA-Z0-9_\-\/]/g, '');
            await systemPool.query(`ALTER DATABASE "${dbName}" SET timezone TO '${safeTz}'`);

            const dbDirectHost = process.env.DB_DIRECT_HOST;
            const dbUser = process.env.DB_USER;
            const dbPass = process.env.DB_PASS;

            const tempClient = new pg.Client({ connectionString: `postgresql://${dbUser}:${dbPass}@${dbDirectHost}:5432/${dbName}` });
            await tempClient.connect();
            try {
                await DatabaseService.initProjectDb(tempClient);
            } finally {
                await tempClient.end().catch(console.error);
            }
            try { 
                const qdrantHost = process.env.QDRANT_HOST;
                if (qdrantHost) {
                    await axios.put(`http://${qdrantHost}:6333/collections/${safeSlug}`, { vectors: { size: 1536, distance: 'Cosine' } }); 
                }
            } catch (e: unknown) { }
            
            // BORN SECURE: Populate default auth rate limits
            await AdminController.createDefaultAuthRules(safeSlug);

            await CertificateService.rebuildNginxConfigs(systemPool);
            res.json({ ...insertRes.rows[0], anon_key: keys.anon, service_key: keys.service, jwt_secret: keys.jwt });
        } catch (e: unknown) {
            const err = e as Error;
            // SAFETY: Clean up BOTH the project record AND the orphan database
            // This prevents the deadly scenario where DB exists but record is gone
            const bodySlug = (req.body as { slug?: string }).slug;
            const sSlug = bodySlug?.toLowerCase().replace(/[^a-z0-9-]/g, '');
            const dName = `cascata_db_${sSlug?.replace(/-/g, '_')}`;
            if (sSlug) {
                await systemPool.query('DELETE FROM system.projects WHERE slug = $1', [sSlug]).catch(() => { });
                await systemPool.query(`DROP DATABASE IF EXISTS "${dName}"`).catch(() => { });
            }
            next(err);
        }
    }

    /**
     * Recover an orphan project: database exists but project record was lost.
     * This creates a new project record pointing to the existing database.
     */
    static async recoverProject(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { slug, name } = req.body as { slug: string; name: string };
        if (!slug || !name) return res.status(400).json({ error: 'slug and name are required.' });

        const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
        const dbName = `cascata_db_${safeSlug.replace(/-/g, '_')}`;

        try {
            // 1. Check if project record already exists
            const existing = await systemPool.query('SELECT 1 FROM system.projects WHERE slug = $1', [safeSlug]);
            if (existing.rows.length > 0) return res.status(409).json({ error: 'Project record already exists. Use normal access.' });

            // 2. Check if orphan database exists
            const dbCheck = await systemPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
            if (dbCheck.rows.length === 0) return res.status(404).json({ error: `No orphan database "${dbName}" found.` });

            // 3. Recreate project record with fresh keys
            const vault = VaultService.getInstance();
            const keys = { anon: await generateKey(), service: await generateKey(), jwt: await generateKey() };
            const encryptedKeys = {
                anon: await vault.encrypt('cascata-system-keys', keys.anon),
                service: await vault.encrypt('cascata-system-keys', keys.service),
                jwt: await vault.encrypt('cascata-system-keys', keys.jwt)
            };

            const insertRes = await systemPool.query(
                "INSERT INTO system.projects (name, slug, db_name, anon_key, service_key, jwt_secret, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
                [name, safeSlug, dbName, encryptedKeys.anon, encryptedKeys.service, encryptedKeys.jwt, JSON.stringify({ recovered: true, recovered_at: new Date().toISOString() })]
            );

            // 4. Born Secure: Populate default auth rate limits
            await AdminController.createDefaultAuthRules(safeSlug);

            // 5. Rebuild nginx configs
            await CertificateService.rebuildNginxConfigs(systemPool);

            console.log(`[AdminController] Recovered orphan project: ${safeSlug} → ${dbName}`);
            res.json({ ...insertRes.rows[0], anon_key: keys.anon, service_key: keys.service, jwt_secret: keys.jwt, recovered: true });
        } catch (e: unknown) { next(e); }
    }

    static async updateProject(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { slug } = req.params;
        if (!slug) return res.status(400).json({ error: 'Project slug is required.' });

        try {
            // Assert project exists before modifications
            const projectCheck = await systemPool.query('SELECT 1 FROM system.projects WHERE slug = $1', [slug]);
            if (projectCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found or already deleted.' });
            }

            const { custom_domain, log_retention_days, metadata, ssl_certificate_source, status, archive_logs } = req.body as { 
                custom_domain?: string; 
                log_retention_days?: number; 
                metadata?: Record<string, unknown>; 
                ssl_certificate_source?: string; 
                status?: string; 
                archive_logs?: boolean; 
            };

            const fields: string[] = [];
            const values: unknown[] = [];
            let idx = 1;

            if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
            if (log_retention_days !== undefined) { fields.push(`log_retention_days = $${idx++}`); values.push(log_retention_days); }
            if (archive_logs !== undefined) { fields.push(`archive_logs = $${idx++}`); values.push(archive_logs); }
            if (ssl_certificate_source !== undefined) { fields.push(`ssl_certificate_source = $${idx++}`); values.push(ssl_certificate_source); }
            if (custom_domain !== undefined) { fields.push(`custom_domain = $${idx++}`); values.push(custom_domain); }

            // VALIDATE GLOBAL CONNECTION CAP
            if (metadata && metadata.db_config) {
                const dbConfig = metadata.db_config as any;
                const requestedMax = parseInt(dbConfig.max_connections || dbConfig.maxConnections || '10', 10);

                const sysConfigRes = await systemPool.query(
                    "SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'system_config'"
                );
                const sysConfig = (sysConfigRes.rows[0]?.settings || {}) as Record<string, unknown>;
                const globalMax = parseInt((sysConfig.maxConnections as string | undefined) || (sysConfig.max_connections as string | undefined) || '100', 10);

                const sumRes = await systemPool.query(`
                    SELECT 
                        SUM(
                            COALESCE(
                                (metadata->'db_config'->>'max_connections')::int, 
                                (metadata->'db_config'->>'maxConnections')::int, 
                                10
                            )
                        ) as total_used 
                    FROM system.projects 
                    WHERE slug != $1
                `, [slug]);

                const totalUsed = parseInt(sumRes.rows[0]?.total_used || '0', 10);
                const remaining = globalMax - totalUsed;

                if (requestedMax > remaining) {
                    return res.status(400).json({
                        error: `Exceeds global infrastructure limits. Only ${remaining} connections remaining for allocation.`
                    });
                }
            }

            if (metadata) {
                fields.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${idx++}::jsonb`);
                values.push(JSON.stringify(metadata));

                // FIX: Hot-Reload database temporal configuration if Admin updates the Timezone
                if (metadata.timezone) {
                    const dbNameRow = await systemPool.query('SELECT db_name FROM system.projects WHERE slug = $1', [slug]);
                    if (dbNameRow.rows.length > 0) {
                        const dbName = dbNameRow.rows[0].db_name as string;
                        const safeTz = (metadata.timezone as string).replace(/[^a-zA-Z0-9_\-\/]/g, '');
                        await systemPool.query(`ALTER DATABASE "${dbName}" SET timezone TO '${safeTz}'`);
                        await PoolService.reload(dbName);
                    }
                }

                // TIER-3 PADLOCK HYBRID SYSTEM ENFORCEMENT
                // Se o payload contiver 'locked_columns', nós chamaremos a stored procedure recém criada
                // no banco de dados do Inquilino para aplicar as Permissões Nativas em Lote (O(1)).
                if (metadata.locked_columns) {
                    const projectSlug = slug;
                    try {
                        // Garantir o Nome do Banco daquele projeto
                        const dbInfo = await systemPool.query('SELECT db_name FROM system.projects WHERE slug = $1', [projectSlug]);
                        if (dbInfo.rows.length > 0) {
                            const dbName = dbInfo.rows[0].db_name as string;
                            const projectPool = await PoolService.get(dbName, { useDirect: true });
                            if (projectPool) {
                                const client = await projectPool.connect();
                                try {
                                    // INJETOR ON-DEMAND: Se a base existir e nunca inicializou o motor The Foundry DDL
                                    // Ele rodará o provisionamento Native Locks no próprio banco do inquilino
                                    await DatabaseService.injectSecurityLockEngine(client);

                                    const columnsPayload = metadata.locked_columns as Record<string, Record<string, unknown>>;
                                    for (const [tableName, locksObj] of Object.entries(columnsPayload)) {
                                        if (typeof locksObj === 'object' && locksObj !== null) {
                                            // Invoca a engine DDL Nativa. O Lock Manager do Node vira apenas um mensageiro.
                                            await client.query(
                                                'SELECT system.apply_security_locks($1, $2, $3::jsonb)',
                                                [projectSlug, tableName, JSON.stringify(locksObj)]
                                            );
                                        }
                                    }
                                } finally {
                                    client.release();
                                }
                            }
                        }
                    } catch (lockErr: unknown) {
                        console.error(`[AdminController] Failed to compile Native DCL Security Locks for ${projectSlug}:`, (lockErr as Error).message);
                    }
                }
            }
            if (fields.length === 0) return res.json({});
            values.push(slug);
            const query = `UPDATE system.projects SET ${fields.join(', ')} WHERE slug = $${idx} RETURNING *`;
            const result = await systemPool.query(query, values);
            
            // --- SYNERGY HOT-RELOAD (Fase 1.6) ---
            // Invalida o Cache L1/L2 em todos os workers para que o Padlock/Masking reflita instantaneamente.
            try {
                const updated = result.rows[0];
                const RateLimitSvc = (await import('../../services/RateLimitService.js')).RateLimitService;
                await RateLimitSvc.invalidateProjectCache(updated.slug, updated.custom_domain);
                
                const PoolSvc = (await import('../../services/PoolService.js')).PoolService;
                await PoolSvc.reload(updated.db_name);

                // Invalida o Cache Semântico do Dragonfly para as tabelas afetadas
                if (metadata && (metadata.locked_columns || metadata.masked_columns)) {
                    const dfly = (RateLimitSvc as any).dragonfly;
                    const tables = new Set([
                        ...Object.keys(metadata.locked_columns || {}),
                        ...Object.keys(metadata.masked_columns || {})
                    ]);
                    for(const table of tables) {
                        try {
                            if (dfly) await dfly.publish('cascata_cache_invalidate', JSON.stringify({ table }));
                        } catch(pubErr: unknown) {}
                    }
                }
            } catch (cacheErr: unknown) {
                console.warn('[AdminController] Hot-Reload post-update failed (Cache may be stale):', (cacheErr as Error).message);
            }

            await CertificateService.rebuildNginxConfigs(systemPool);
            res.json(result.rows[0]);
        } catch (e: unknown) { next(e); }
    }

    static async deleteProject(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { slug } = req.params;
        try {
            const projectResult = await systemPool.query('SELECT * FROM system.projects WHERE slug = $1', [slug]);
            const project = projectResult.rows[0];
            if (!project) return res.status(404).json({ error: 'Not found' });
            
            const dbName = project.db_name as string;
            await PoolService.terminate(dbName);
            await systemPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
            await systemPool.query(`DELETE FROM system.projects WHERE slug = $1`, [slug]);
            
            const storagePath = path.join(STORAGE_ROOT, slug);
            if (fs.existsSync(storagePath)) {
                await fs.promises.rm(storagePath, { recursive: true, force: true });
            }
            
            await CertificateService.rebuildNginxConfigs(systemPool);
            res.json({ success: true });
        } catch (e: unknown) { next(e); }
    }

    static async revealKey(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { slug } = req.params;
        const { keyType, password } = req.body as { keyType: string; password: string };
        // SECURITY: Whitelist to prevent SQL injection via keyType interpolation
        const ALLOWED_KEY_TYPES: Record<string, string> = {
            anon_key: 'anon_key',
            service_key: 'service_key',
            jwt_secret: 'jwt_secret'
        };
        const safeKeyType = ALLOWED_KEY_TYPES[keyType];
        if (!safeKeyType) return res.status(400).json({ error: 'Invalid key type.' });

        try {
            const adminResult = await systemPool.query('SELECT password_hash FROM system.admin_users LIMIT 1');
            const admin = adminResult.rows[0];
            const isValid = await bcrypt.compare(password, admin.password_hash as string);
            if (!isValid) return res.status(403).json({ error: "Invalid Password" });
            
            const keyRes = await systemPool.query(`SELECT ${safeKeyType} as key FROM system.projects WHERE slug = $1`, [slug]);
            let key = keyRes.rows[0].key as string | null;

            if (key && key.startsWith('vault:')) {
                const vault = VaultService.getInstance();
                key = await vault.decrypt('cascata-system-keys', key);
            }

            res.json({ key });
        } catch (e: unknown) { next(e); }
    }

    static async rotateKeys(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { slug } = req.params;
        const { type } = req.body as { type: string };
        try { 
            const newKey = await generateKey();
            const vault = VaultService.getInstance();
            const encryptedKey = await vault.encrypt('cascata-system-keys', newKey);
            
            const col = type === 'anon' ? 'anon_key' : 'service_key';
            await systemPool.query(`UPDATE system.projects SET ${col} = $1 WHERE slug = $2`, [encryptedKey, slug]); 
            res.json({ success: true }); 
        } catch (e: unknown) { next(e); }
    }

    static async updateSecrets(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { slug } = req.params;
        const { secrets } = req.body as { secrets: Record<string, string> };
        try { 
            await systemPool.query(`UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{secrets}', $1) WHERE slug = $2`, [JSON.stringify(secrets), slug]); 
            res.json({ success: true }); 
        } catch (e: unknown) { next(e); }
    }

    static async blockIp(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { slug } = req.params;
        const { ip } = req.body as { ip: string };
        try { 
            await systemPool.query('UPDATE system.projects SET blocklist = array_append(blocklist, $1) WHERE slug = $2', [ip, slug]); 
            res.json({ success: true }); 
        } catch (e: unknown) { next(e); }
    }

    static async unblockIp(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { slug } = req.params;
        const { ip } = req.body as { ip: string };
        try { 
            await systemPool.query('UPDATE system.projects SET blocklist = array_remove(blocklist, $1) WHERE slug = $2', [ip, slug]); 
            res.json({ success: true }); 
        } catch (e: unknown) { next(e); }
    }

    static async purgeLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { slug } = req.params;
        const days = Number(req.query.days);
        const archive = req.query.archive === 'true';
        try { 
            await systemPool.query(`SELECT system.purge_old_logs($1, $2, $3)`, [slug, days, archive]); 
            res.json({ success: true }); 
        } catch (e: unknown) { next(e); }
    }

    static async exportProject(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { slug } = req.params;
        try {
            const projectResult = await systemPool.query('SELECT * FROM system.projects WHERE slug = $1', [slug]);
            const project = projectResult.rows[0];
            if (!project) return res.status(404).json({ error: 'Project not found' });

            // DESCRIPTOGRAFIA SEGURA (VAULT)
            const vault = VaultService.getInstance();
            const keys: Record<string, string> = {};
            const keysToDecrypt = ['jwt_secret', 'anon_key', 'service_key'];
            
            for (const k of keysToDecrypt) {
                const val = project[k] as string | null;
                if (val && val.startsWith('vault:')) {
                    keys[k] = await vault.decrypt('cascata-system-keys', val);
                } else if (val) {
                    keys[k] = val;
                }
            }

            await BackupService.streamExport({ ...project, ...keys }, res);
        } catch (e: unknown) { 
            if (!res.headersSent) res.status(500).json({ error: (e as Error).message }); 
        }
    }

    static async exportLogsToCloud(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { slug } = req.params;
        try {
            const projectResult = await systemPool.query('SELECT db_name FROM system.projects WHERE slug = $1', [slug]);
            const project = projectResult.rows[0];
            if (!project) return res.status(404).json({ error: 'Project not found.' });

            if (!process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
                return res.status(400).json({ error: 'System not configured for Cloud Storage Exports. Verify S3 credentials.' });
            }

            const insertRes = await systemPool.query(
                `INSERT INTO system.async_operations (project_slug, type, status, metadata) 
                 VALUES ($1, 'log_export', 'pending', $2) RETURNING id`,
                [slug, JSON.stringify({ request_time: new Date().toISOString() })]
            );

            await QueueService.addLogExportJob({ operationId: insertRes.rows[0].id, slug, db_name: project.db_name as string });
            res.json({ success: true, operation_id: insertRes.rows[0].id, message: 'Log export is processing in background.' });
        } catch (e: unknown) { next(e); }
    }

    static async uploadImport(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        // SAFETY: Casting to unknown before accessing property is better than any.
        const multerReq = (req as unknown) as { file?: { path: string } };
        if (!multerReq.file) return res.status(400).json({ error: 'No file uploaded' });
        try {
            const manifest = await ImportService.validateBackup(multerReq.file.path);
            res.json({ success: true, manifest, temp_path: multerReq.file.path });
        } catch (e: unknown) { 
            if (multerReq.file) fs.unlinkSync(multerReq.file.path); 
            res.status(400).json({ error: (e as Error).message }); 
        }
    }

    static async analyzeImport(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { temp_path, slug } = req.body as { temp_path: string; slug: string };
        try {
            const diffReport = await ImportService.stageAndAnalyze(temp_path, slug, systemPool);
            res.json({ success: true, diff: diffReport });
        } catch (e: unknown) { next(e); }
    }

    static async executeImport(req: Request, res: Response, next: NextFunction): Promise<void> {
        // Migration strategies have complex types (e.g., specific strings).
        // Using any for strategies to satisfy external service signatures.
        const { slug, temp_db_name, strategies, preserve_keys } = req.body as { slug: string; temp_db_name: string; strategies: any; preserve_keys: boolean };
        try {
            const insertRes = await systemPool.query(
                `INSERT INTO system.async_operations (project_slug, type, status, metadata) 
                 VALUES ($1, 'restore', 'processing', $2) RETURNING id`,
                [slug, JSON.stringify({ strategies, temp_db_name })]
            );
            const opId = insertRes.rows[0].id as string;

            (async () => {
                try {
                    const result = await ImportService.executeMigration(slug, temp_db_name, strategies, systemPool, preserve_keys);
                    await systemPool.query(
                        'UPDATE system.async_operations SET status = $1, result = $2, updated_at = NOW() WHERE id = $3',
                        ['completed', JSON.stringify(result), opId]
                    );
                } catch (err: unknown) {
                    await systemPool.query(
                        'UPDATE system.async_operations SET status = $1, result = $2, updated_at = NOW() WHERE id = $3',
                        ['failed', JSON.stringify({ error: (err as Error).message }), opId]
                    );
                }
            })();

            res.json({ success: true, operation_id: opId });
        } catch (e: unknown) { next(e); }
    }

    static async revertImport(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { slug, rollback_id } = req.body as { slug: string; rollback_id: string };
        try {
            if (!rollback_id) return res.status(400).json({ error: "Rollback ID required" });
            await ImportService.revertRestore(slug, rollback_id, systemPool);
            res.json({ success: true, message: "System reverted to pre-import state." });
        } catch (e: unknown) { next(e); }
    }

    static async confirmImport(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { temp_path, slug, name, mode, include_data } = req.body as { temp_path: string; slug: string; name: string; mode?: string; include_data?: boolean };
        try {
            const insertRes = await systemPool.query(`INSERT INTO system.async_operations (project_slug, type, status, metadata) VALUES ($1, 'import', 'pending', $2) RETURNING id`, [slug, JSON.stringify({ name, temp_path })]);
            await QueueService.addRestoreJob({ operationId: insertRes.rows[0].id, temp_path, slug, name, mode: mode || 'recovery', include_data: include_data !== false });
            res.json({ success: true, operation_id: insertRes.rows[0].id });
        } catch (e: unknown) { next(e); }
    }

    static async getOperationStatus(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { id } = req.params;
        try {
            const result = await systemPool.query('SELECT * FROM system.async_operations WHERE id = $1', [id]);
            if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
            const op = result.rows[0];
            if (op.status === 'completed' && op.type === 'restore') await CertificateService.rebuildNginxConfigs(systemPool);
            res.json(op);
        } catch (e: unknown) { next(e); }
    }

    static async listWebhooks(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { slug } = req.params;
        try {
            const result = await systemPool.query(
                'SELECT id, project_slug, target_url, event_type, table_name, secret_header, filters, fallback_url, retry_policy, created_at, updated_at FROM system.webhooks WHERE project_slug = $1 ORDER BY created_at DESC',
                [slug]
            );
            res.json(result.rows);
        } catch (e: unknown) { next(e); }
    }

    static async createWebhook(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { slug } = req.params;
        const { target_url, event_type, table_name, filters, fallback_url, retry_policy } = req.body as {
            target_url: string;
            event_type: string;
            table_name: string;
            filters?: unknown[];
            fallback_url?: string;
            retry_policy?: Record<string, unknown>;
        };
        try {
            if (!target_url || !event_type || !table_name) {
                return res.status(400).json({ error: 'Missing required fields: target_url, event_type, table_name' });
            }

            const secretRes = await systemPool.query("SELECT jwt_secret FROM system.projects WHERE slug = $1", [slug]);
            if (secretRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
            
            let secret = secretRes.rows[0].jwt_secret as string | null;
            if (secret && secret.startsWith('vault:')) {
                const vault = VaultService.getInstance();
                secret = await vault.decrypt('cascata-system-keys', secret);
            }

            const result = await systemPool.query(
                `INSERT INTO system.webhooks 
                (project_slug, target_url, event_type, table_name, secret_header, filters, fallback_url, retry_policy) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
                RETURNING id, project_slug, target_url, event_type, table_name, secret_header, filters, fallback_url, retry_policy`,
                [slug, target_url, event_type, table_name, secret, JSON.stringify(filters || []), fallback_url, retry_policy]
            );
            res.status(201).json(result.rows[0]);
        } catch (e: unknown) { next(e); }
    }

    static async deleteWebhook(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { id, slug } = req.params;
        try {
            const result = await systemPool.query(
                'DELETE FROM system.webhooks WHERE id = $1 AND project_slug = $2 RETURNING id',
                [id, slug]
            );
            if (result.rows.length === 0) return res.status(404).json({ error: 'Webhook not found' });
            res.json({ success: true });
        } catch (e: unknown) { next(e); }
    }

    static async updateWebhook(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { id, slug } = req.params;
        const { target_url, event_type, table_name, filters, fallback_url, retry_policy } = req.body as {
            target_url?: string;
            event_type?: string;
            table_name?: string;
            filters?: unknown[];
            fallback_url?: string;
            retry_policy?: Record<string, unknown>;
        };
        try {
            const fields: string[] = [];
            const values: unknown[] = [];
            let idx = 1;

            if (target_url !== undefined) { fields.push(`target_url = $${idx++}`); values.push(target_url); }
            if (event_type !== undefined) { fields.push(`event_type = $${idx++}`); values.push(event_type); }
            if (table_name !== undefined) { fields.push(`table_name = $${idx++}`); values.push(table_name); }
            if (filters !== undefined) { fields.push(`filters = $${idx++}`); values.push(JSON.stringify(filters)); }
            if (fallback_url !== undefined) { fields.push(`fallback_url = $${idx++}`); values.push(fallback_url); }
            if (retry_policy !== undefined) { fields.push(`retry_policy = $${idx++}`); values.push(JSON.stringify(retry_policy)); }

            if (fields.length === 0) return res.json({ success: true });

            values.push(id, slug);
            const query = `UPDATE system.webhooks SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} AND project_slug = $${idx + 1} RETURNING *`;

            const result = await systemPool.query(query, values);
            if (result.rows.length === 0) return res.status(404).json({ error: 'Webhook not found' });

            res.json(result.rows[0]);
        } catch (e: unknown) { next(e); }
    }

    static async testWebhook(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
        const { id, slug } = req.params;
        const { payload } = req.body as { payload?: Record<string, unknown> };
        try {
            const hookRes = await systemPool.query('SELECT * FROM system.webhooks WHERE id = $1 AND project_slug = $2', [id, slug]);
            if (hookRes.rows.length === 0) return res.status(404).json({ error: 'Webhook not found' });

            const hook = hookRes.rows[0];
            const projRes = await systemPool.query("SELECT jwt_secret FROM system.projects WHERE slug = $1", [hook.project_slug]);

            let jwtSecret = projRes.rows[0].jwt_secret;
            if (jwtSecret && jwtSecret.startsWith('vault:')) {
                const vault = VaultService.getInstance();
                jwtSecret = await vault.decrypt('cascata-system-keys', jwtSecret);
            }

            await WebhookService.dispatch(
                hook.project_slug as string,
                hook.table_name as string,
                hook.event_type as string,
                payload || { test: true, timestamp: new Date().toISOString() },
                systemPool,
                jwtSecret as string
            );

            res.json({ success: true, message: 'Test payload scheduled for dispatch via WebhookService' });
        } catch (e: unknown) { next(e); }
    }

    static async getSystemSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const domainRes = await systemPool.query("SELECT settings->>'domain' as domain FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'domain_config'");
            const aiRes = await systemPool.query("SELECT settings as ai_config FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const dbRes = await systemPool.query("SELECT settings as db_config FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'system_config'");

            res.json({
                domain: domainRes.rows[0]?.domain,
                ai_config: aiRes.rows[0]?.ai_config || {},
                db_config: dbRes.rows[0]?.db_config || {}
            });
        } catch (e: unknown) { next(e); }
    }

    static async updateSystemSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { domain, ai_config, db_config } = req.body as { domain?: string; ai_config?: Record<string, unknown>; db_config?: Record<string, unknown> };
        try {
            await systemPool.query('BEGIN');

            if (domain !== undefined) {
                await systemPool.query("INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ('_system_root_', 'domain_config', $1) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1", [JSON.stringify({ domain })]);
                await CertificateService.rebuildNginxConfigs(systemPool);
            }

            if (ai_config) {
                await systemPool.query("INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ('_system_root_', 'ai_config', $1) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1", [JSON.stringify(ai_config)]);
            }

            if (db_config) {
                await systemPool.query("INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ('_system_root_', 'system_config', $1) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1", [JSON.stringify(db_config)]);
                PoolService.configure(db_config);
                RateLimitService.refreshGlobalSettings().catch((e: Error) => console.error("Refresh GLobal Settings error", e.message));
            }

            await systemPool.query('COMMIT');
            res.json({ success: true });
        } catch (e: unknown) {
            await systemPool.query('ROLLBACK');
            next(e);
        }
    }

    static async checkSsl(req: Request, res: Response, next: NextFunction): Promise<void> {
        res.json({ status: 'active', timestamp: new Date().toISOString() });
    }

    static async listCertificates(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const certs = await CertificateService.listAvailableCerts();
            res.json({ domains: certs });
        } catch (e: unknown) { next(e); }
    }

    static async createCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { domain, email, provider, cert, key } = req.body as { domain: string; email?: string; provider?: string; cert?: string; key?: string };
        try {
            if (!domain) {
                res.status(400).json({ error: 'Domain is required' });
                return;
            }
            const result = await CertificateService.requestCertificate(domain, email || '', (provider as any) || '', systemPool, { cert, key } as any);
            res.json(result);
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    }

    static async deleteCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
        const { domain } = req.params;
        try {
            if (!domain) {
                res.status(400).json({ error: 'Domain param is required' });
                return;
            }
            await CertificateService.deleteCertificate(domain, systemPool);
            res.json({ success: true, message: `SSL Certificate for ${domain} wiped and nginx reloaded.` });
        } catch (e: unknown) { res.status(500).json({ error: (e as Error).message }); }
    }

    static async getServerPublicIp(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const response = await axios.get<{ ip: string }>('https://api.ipify.org?format=json', { timeout: 5000 });
            res.json(response.data);
        } catch (e: unknown) {
            res.json({ ip: 'Local/Discovery Mode' });
        }
    }

    private static async createDefaultAuthRules(slug: string) {
        const defaultRules = [
            { pattern: 'auth:otp_request', name: 'OTP Requests', rate: 3, burst: 5, secs: 60 },
            { pattern: 'auth:login', name: 'Login Attempts', rate: 5, burst: 10, secs: 60 },
            { pattern: 'auth:recovery', name: 'Account Recovery', rate: 2, burst: 3, secs: 3600 },
            { pattern: 'auth:signup', name: 'New Signups', rate: 5, burst: 5, secs: 3600 },
            { pattern: 'auth:verify', name: 'OTP Verifications', rate: 10, burst: 20, secs: 60 },
            { pattern: 'auth:update_user', name: 'Profile/Security Updates', rate: 5, burst: 5, secs: 60 }
        ];

        for (const r of defaultRules) {
            await systemPool.query(
                `INSERT INTO system.rate_limits (project_slug, route_pattern, method, rate_limit, burst_limit, window_seconds) 
                 VALUES ($1, $2, 'ALL', $3, $4, $5)
                 ON CONFLICT DO NOTHING`,
                [slug, r.pattern, r.rate, r.burst, r.secs]
            );
        }
        await RateLimitService.refreshGlobalSettings().catch(() => {});
    }
}
