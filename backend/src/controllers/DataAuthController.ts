
import { NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { AuthService } from '../../services/AuthService.js';
import { GoTrueService } from '../../services/GoTrueService.js';
import { RateLimitService, AuthSecurityConfig } from '../../services/RateLimitService.js';
import { WebhookService } from '../../services/WebhookService.js';
import { quoteId } from '../utils/index.js';
import { Buffer } from 'buffer';

export class DataAuthController {

    // --- HELPER: Cookie Setting ---
    // Sets HttpOnly, Secure, SameSite cookies for Hybrid Auth
    private static setAuthCookies(res: any, session: any) {
        const isProd = process.env.NODE_ENV === 'production';
        const cookieOptions = {
            httpOnly: true,
            secure: isProd,
            sameSite: 'Lax', // Allows redirects from OAuth providers to work
            path: '/'
        };

        // Access Token (Short lived)
        res.cookie('cascata_access_token', session.access_token, {
            ...cookieOptions,
            maxAge: session.expires_in * 1000
        });

        // Refresh Token (Long lived)
        // Note: Refresh token expiration is typically 30 days, we match it here.
        res.cookie('cascata_refresh_token', session.refresh_token, {
            ...cookieOptions,
            maxAge: 30 * 24 * 60 * 60 * 1000
        });
    }

    private static getDeviceInfo(req: any) {
        const forwarded = req.headers['x-forwarded-for'];
        const realIp = req.headers['x-real-ip'];
        const socketIp = req.socket?.remoteAddress;
        let ip = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
        ip = ip.replace('::ffff:', '');

        const userAgent = req.headers['user-agent'] || 'unknown';
        const fingerprint = req.headers['x-cascata-fingerprint'] || 'incognito';
        return { ip, userAgent, fingerprint };
    }

    private static validateOrigin(req: CascataRequest, origin: string): boolean {
        const allowed = req.project.metadata?.allowed_origins || [];
        if (allowed.length === 0 || allowed.includes('*')) return true;
        
        // Match exact or wildcard (e.g., https://*.myapp.com)
        return allowed.some((pattern: string) => {
            if (pattern === origin) return true;
            if (pattern.includes('*')) {
                const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
                return regex.test(origin);
            }
            return false;
        });
    }

    private static getRequestOrigin(req: any): string {
        const origin = req.headers.origin || req.headers.referer || '*';
        if (origin === '*') return '*';
        try {
            const url = new URL(origin);
            return url.hostname;
        } catch (e) { return origin; }
    }

    private static async evaluatePolicy(req: CascataRequest, provider: string) {
        const origin = DataAuthController.getRequestOrigin(req);
        const result = await req.projectPool!.query(`
            SELECT * FROM auth.policies 
            WHERE active = true 
            AND (provider = $1 OR provider = '*')
            AND (origin = $2 OR origin = '*' OR origin = 'localhost')
            ORDER BY priority DESC LIMIT 1
        `, [provider, origin]);
        return result.rows[0] || null;
    }

    private static async checkNeutralized(req: CascataRequest, identifier: string): Promise<{ neutralized: boolean, reason?: string }> {
        // Check for specific user neutralization OR global revocation
        const result = await req.projectPool!.query(`
            SELECT metadata->>'reason' as reason FROM auth.panic_revocations 
            WHERE (target_type = 'user' AND target_value = $1)
               OR (target_type = 'global' AND target_value = 'ALL')
            ORDER BY created_at DESC LIMIT 1
        `, [identifier]);

        if (result.rows.length > 0) {
            return { neutralized: true, reason: result.rows[0].reason };
        }
        return { neutralized: false };
    }

    private static getSecurityConfig(req: CascataRequest): AuthSecurityConfig {
        const meta = req.project?.metadata?.auth_config?.security || {};
        return {
            max_attempts: meta.max_attempts || 5,
            lockout_minutes: meta.lockout_minutes || 15,
            strategy: meta.strategy || 'hybrid',
            disabled: meta.disabled || false
        };
    }

    static async listUsers(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        try {
            const result = await req.projectPool!.query(`SELECT u.id, u.created_at, u.banned, u.last_sign_in_at, jsonb_agg(jsonb_build_object('id', i.id, 'provider', i.provider, 'identifier', i.identifier, 'verified_at', i.verified_at)) as identities FROM auth.users u LEFT JOIN auth.identities i ON u.id = i.user_id GROUP BY u.id ORDER BY u.created_at DESC`);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async createUser(req: CascataRequest, res: any, next: any) {
        const { strategies, profileData } = req.body;
        try {
            const client = await req.projectPool!.connect();
            try {
                await client.query('BEGIN');
                const userRes = await client.query('INSERT INTO auth.users (raw_user_meta_data) VALUES ($1) RETURNING id', [profileData || {}]);
                const userId = userRes.rows[0].id;
                if (strategies) {
                    for (const s of strategies) {
                        let passwordHash = s.password ? await bcrypt.hash(s.password, 10) : null;
                        await client.query('INSERT INTO auth.identities (user_id, provider, identifier, password_hash) VALUES ($1, $2, $3, $4)', [userId, s.provider, s.identifier, passwordHash]);
                    }
                }
                await client.query('COMMIT');
                res.json({ success: true, id: userId });
            } finally { client.release(); }
        } catch (e: any) { next(e); }
    }

    /**
     * UNIVERSAL LOGIN (formerly legacyToken)
     * The agnostic entry point for ANY auth strategy (CPF, Email, Biometrics, etc).
     */
    static async legacyToken(req: CascataRequest, res: any, next: any) {
        const { provider, identifier, password, otp_code } = req.body;
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        const origin = req.headers.origin || req.headers.referer || '*';

        if (!provider || !identifier) {
            return res.status(400).json({ error: 'Provider and identifier are required.' });
        }

        const secConfig = DataAuthController.getSecurityConfig(req);

        try {
            // FIREWALL: Check Dragonfly BEFORE hitting PostgreSQL
            const lockout = await RateLimitService.checkAuthLockout(req.project.slug, deviceInfo.ip!, identifier, secConfig);
            if (lockout.locked) return res.status(429).json({ error: lockout.reason });

            // SOVEREIGN HARDENING: Origin Integrity Check
            const isOriginTrusted = DataAuthController.validateOrigin(req, origin);
            
            // C-LEVEL: Resolve Auth Orchestration Policy
            // If origin is untrusted, we inject 'untrusted' into context to force strict laws
            const policyRes = await req.projectPool!.query(
                `SELECT auth.resolve_policy('login', $1, $2, $3::jsonb) as policy`, 
                [provider, origin, JSON.stringify({ is_origin_trusted: isOriginTrusted })]
            );
            const policy = policyRes.rows[0].policy;

            // SOVEREIGN PANIC: Immediate check for origin/provider revocation
            const panicRes = await req.projectPool!.query(
                `SELECT COUNT(*) FROM auth.panic_revocations WHERE target_value = $1 OR target_value = $2`,
                [origin, provider]
            );
            if (parseInt(panicRes.rows[0].count) > 0) {
                await AuthService.logAuthEvent(req.projectPool!, null, 'login', provider, identifier, origin, deviceInfo.ip!, 'blocked', policy.name, { reason: 'panic_revocation_active' });
                return res.status(401).json({ error: 'This access point has been temporarily suspended by project owner.' });
            }

            const idRes = await req.projectPool!.query('SELECT * FROM auth.identities WHERE provider = $1 AND identifier = $2', [provider, identifier]);

            if (!idRes.rows[0]) {
                await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, identifier, secConfig);
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const identity = idRes.rows[0];
            const storedHash = identity.password_hash;

            // ORCHESTRATION: Enforce Laws defined by the Owner
            // 1. Password Verification
            if (policy.require_password !== false) {
                if (!storedHash) {
                    await AuthService.logAuthEvent(req.projectPool!, identity.user_id, 'login', provider, identifier, origin, deviceInfo.ip!, 'failure', policy.name, { error: 'identity_no_password' });
                    return res.status(400).json({ error: 'This identity does not support password login (but policy requires it).' });
                }
                if (!password) {
                    await AuthService.logAuthEvent(req.projectPool!, identity.user_id, 'login', provider, identifier, origin, deviceInfo.ip!, 'challenge_required', policy.name, { challenge: 'password' });
                    return res.status(401).json({ error: 'password_required', message: 'Password is required for this login flow.' });
                }
                const isValid = await bcrypt.compare(password, storedHash);
                if (!isValid) {
                    await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, identifier, secConfig);
                    await AuthService.logAuthEvent(req.projectPool!, identity.user_id, 'login', provider, identifier, origin, deviceInfo.ip!, 'failure', policy.name, { error: 'invalid_password' });
                    return res.status(401).json({ error: 'Invalid credentials' });
                }
            }

            // 2. MFA Verification (OTP / TOTP)
            // If the policy requires user choice, check if they have MFA enabled
            const mfaRequired = policy.require_otp === true || 
                                (policy.require_user_mfa_choice === true && identity.identity_data?.mfa_enabled === true);

            if (mfaRequired) {
                // Check if they have a TOTP identity linked
                const totpIdRes = await req.projectPool!.query(`SELECT identifier FROM auth.identities WHERE user_id = $1 AND provider = 'totp' LIMIT 1`, [identity.user_id]);
                const hasTotp = totpIdRes.rows.length > 0;

                if (hasTotp) {
                    const reqTotp = req.body.totp_code;
                    if (!reqTotp) return res.status(403).json({ error: 'totp_required', message: 'Authenticator Code required.' });
                    
                    // Anti-Replay Check
                    const usedRes = await req.projectPool!.query(`SELECT 1 FROM auth.used_totp_codes WHERE user_id = $1 AND code = $2 AND used_at > now() - interval '5 minutes'`, [identity.user_id, reqTotp]);
                    if (usedRes.rows.length > 0) return res.status(401).json({ error: 'code_reused', message: 'This code has already been used. Please wait for the next one.' });

                    const isValidTotp = await AuthService.verifyTOTP(totpIdRes.rows[0].identifier, reqTotp);
                    if (!isValidTotp) return res.status(401).json({ error: 'invalid_totp', message: 'Invalid Authenticator Code.' });

                    // Log usage for anti-replay
                    await req.projectPool!.query(`INSERT INTO auth.used_totp_codes (user_id, code) VALUES ($1, $2)`, [identity.user_id, reqTotp]);
                } else {
                    // Standard OTP Logic
                    if (!otp_code) {
                        return res.status(403).json({ 
                            error: 'otp_required', 
                            message: 'Multi-Factor Challenge required for this login origin.',
                            provider,
                            identifier
                        });
                    }
                    await AuthService.verifyPasswordless(req.projectPool!, provider, identifier, otp_code);
                }
            }

            // SUCCESS Phase
            await RateLimitService.clearAuthFailure(req.project.slug, deviceInfo.ip!, identifier);
            await AuthService.logAuthEvent(req.projectPool!, identity.user_id, 'login', provider, identifier, origin, deviceInfo.ip!, 'success', policy.name);

            // Create session with the specific provider context AND Fingerprint
            const session = await AuthService.createSession(
                identity.user_id,
                req.projectPool!,
                req.project.jwt_secret,
                '1h',
                30,
                provider,
                deviceInfo
            );

            DataAuthController.setAuthCookies(res, session);
            res.json(session);
        } catch (e: any) { next(e); }
    }

    static async linkIdentity(req: CascataRequest, res: any, next: any) {
        const userId = req.params.id;
        const { provider, identifier, password, otp_code } = req.body;
        const origin = req.headers.origin || req.headers.referer || '*';

        // SECURITY: If not service_role, must be linking to SELF
        if (req.userRole !== 'service_role' && req.user?.sub !== userId) {
            return res.status(403).json({ error: 'Access Denied: You can only link identities to your own account.' });
        }

        try {
            const client = await req.projectPool!.connect();
            try {
                // Fetch User Context for Policy (How were they born?)
                const userCtxRes = await client.query(
                    `SELECT provider as created_via_provider, created_via_origin FROM auth.identities WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
                    [userId]
                );
                const userContext = userCtxRes.rows[0] || {};

                // ORCHESTRATION: Check Policy for Linking
                const policyRes = await client.query(
                    `SELECT auth.resolve_policy('link', $1, $2, $3::jsonb) as policy`, 
                    [provider, origin, JSON.stringify(userContext)]
                );
                const policy = policyRes.rows[0].policy;

                if (policy.require_password === true && !password && req.userRole !== 'service_role') {
                    // Password check logic here if needed (e.g. verify account password or new identity password)
                    // For linking, we usually require the NEW identity password if it's an email/pass combo
                }

                if (policy.require_otp === true && !otp_code && req.userRole !== 'service_role') {
                    return res.status(403).json({ error: 'otp_required', message: 'Identity linking requires OTP verification for this provider.', provider, identifier });
                }

                if (otp_code && req.userRole !== 'service_role') {
                    await AuthService.verifyPasswordless(req.projectPool!, provider, identifier, otp_code);
                }

                await client.query('BEGIN');
                const passwordHash = password ? await bcrypt.hash(password, 10) : null;
                await client.query('INSERT INTO auth.identities (user_id, provider, identifier, password_hash, created_at, created_via_origin) VALUES ($1, $2, $3, $4, now(), $5)', [userId, provider, identifier, passwordHash, origin]);
                await client.query('COMMIT');
                
                await AuthService.logAuthEvent(req.projectPool!, userId, 'link', provider, identifier, origin, '0.0.0.0', 'success', policy.name);
                res.json({ success: true });
            } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        } catch (e: any) { 
            next(e); 
        }
    }

    static async unlinkIdentity(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: 'Unlinking identities requires administrative privileges (Service Role).' });
        }
        try {
            const countRes = await req.projectPool!.query('SELECT count(*) FROM auth.identities WHERE user_id = $1', [req.params.id]);
            if (parseInt(countRes.rows[0].count) <= 1) return res.status(400).json({ error: "Cannot remove the last identity." });
            await req.projectPool!.query('DELETE FROM auth.identities WHERE id = $1 AND user_id = $2', [req.params.identityId, req.params.id]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async updateUserStatus(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: 'Access Denied: Only Service Role can update user status.' });
        }
        try { await req.projectPool!.query('UPDATE auth.users SET banned = $1 WHERE id = $2', [req.body.banned, req.params.id]); res.json({ success: true }); } catch (e: any) { next(e); }
    }

    static async deleteUser(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: 'Access Denied: Only Service Role can delete users.' });
        }
        try { await req.projectPool!.query('DELETE FROM auth.users WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (e: any) { next(e); }
    }

    static async linkConfig(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') return res.status(403).json({ error: 'Unauthorized' });
        try {
            const metaUpdates: any = { auth_strategies: req.body.authStrategies, auth_config: req.body.authConfig, linked_tables: req.body.linked_tables };

            // Auto-Sync Auth Strategy Origins to Global CORS Perimeter
            if (req.body.authStrategies) {
                let currentOrigins = [...(req.project.metadata?.allowed_origins || [])];
                const originValues = currentOrigins.map((o: any) => typeof o === 'string' ? o : o.url);
                let added = false;

                Object.values(req.body.authStrategies).forEach((strategy: any) => {
                    if (strategy.rules && Array.isArray(strategy.rules)) {
                        strategy.rules.forEach((rule: any) => {
                            if (rule.origin && !originValues.includes(rule.origin)) {
                                currentOrigins.push(rule.origin);
                                originValues.push(rule.origin);
                                added = true;
                            }
                        });
                    }
                });

                if (added) {
                    metaUpdates.allowed_origins = currentOrigins;
                }
            }

            await systemPool.query(`UPDATE system.projects SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE slug = $2`, [JSON.stringify(metaUpdates), req.project.slug]);
            if (req.body.linked_tables?.length > 0) {
                const client = await req.projectPool!.connect();
                try {
                    await client.query('BEGIN');
                    for (const table of req.body.linked_tables) {
                        await client.query(`ALTER TABLE public.${quoteId(table)} ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`);
                        await client.query(`CREATE INDEX IF NOT EXISTS ${quoteId('idx_' + table + '_user_id')} ON public.${quoteId(table)} (user_id)`);
                    }
                    await client.query('COMMIT');
                } finally { client.release(); }
            }
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async challenge(req: CascataRequest, res: any, next: any) {
        try {
            const strategies = req.project.metadata?.auth_strategies || {};
            const config = strategies[req.body.provider];
            if (!config?.enabled || !config?.webhook_url) throw new Error("Strategy not configured.");

            const language = req.body.language || 'en-US';
            const messagingTemplates = req.project.metadata?.auth_config?.messaging_templates;
            const templateBindings = config.template_bindings;

            await AuthService.initiatePasswordless(
                req.projectPool!,
                req.body.provider,
                req.body.identifier,
                config.webhook_url,
                req.project.jwt_secret,
                config.otp_config || { length: 6, charset: 'numeric' },
                language,
                messagingTemplates,
                templateBindings
            );
            res.json({ success: true, message: 'Challenge sent' });
        } catch (e: any) { next(e); }
    }

    static async verifyChallenge(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        const { provider, identifier, code } = req.body;
        const secConfig = DataAuthController.getSecurityConfig(req);

        try {
            // FIREWALL: Check for lockout
            if (identifier) {
                const lockout = await RateLimitService.checkAuthLockout(req.project.slug, deviceInfo.ip!, identifier, secConfig);
                if (lockout.locked) return res.status(429).json({ error: lockout.reason });

                const neutralization = await DataAuthController.checkNeutralized(req, identifier);
                if (neutralization.neutralized) return res.status(401).json({ error: 'User access neutralized by Sovereign Panic Signal.', reason: neutralization.reason });
            }

            const policy = await DataAuthController.evaluatePolicy(req, provider);
            
            // Policy Enforcement: Block access if not active or specific conditions not met
            if (policy && policy.active === false) return res.status(403).json({ error: 'Security Policy Block: This authentication path is currently suspended.' });

            const profile = await AuthService.verifyPasswordless(req.projectPool!, provider, identifier, code);
            const userId = await AuthService.upsertUser(req.projectPool!, profile);

            // Success: Clear failures
            if (identifier) await RateLimitService.clearAuthFailure(req.project.slug, deviceInfo.ip!, identifier);

            const session = await AuthService.createSession(
                userId,
                req.projectPool!,
                req.project.jwt_secret,
                '1h',
                30,
                provider,
                deviceInfo
            );

            DataAuthController.setAuthCookies(res, session);
            res.json(session);
        } catch (e: any) {
            // Register failure on error
            if (identifier) await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, identifier, secConfig);
            next(e);
        }
    }

    static async setupTOTP(req: CascataRequest, res: any, next: any) {
        if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
        try {
            const issuer = req.project.name || 'Cascata';
            const label = req.user.email || req.user.sub;
            const { secret, url } = AuthService.generateTOTPSecret(issuer, label);
            
            // Store secret temporarily in metadata until verified
            await req.projectPool!.query(
                `UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || jsonb_build_object('totp_pending_secret', $1) WHERE id = $2`,
                [secret, req.user.sub]
            );
            
            res.json({ secret, qr_url: url });
        } catch (e: any) { next(e); }
    }

    static async verifyTOTPEnrollment(req: CascataRequest, res: any, next: any) {
        if (!req.user?.sub) return res.status(401).json({ error: 'Unauthorized' });
        const { code } = req.body;
        try {
            const userRes = await req.projectPool!.query(`SELECT raw_user_meta_data FROM auth.users WHERE id = $1`, [req.user.sub]);
            const secret = userRes.rows[0]?.raw_user_meta_data?.totp_pending_secret;
            if (!secret) return res.status(400).json({ error: 'No TOTP setup in progress.' });

            const isValid = await AuthService.verifyTOTP(secret, code);
            if (!isValid) {
                await AuthService.logAuthEvent(req.projectPool!, req.user.sub, 'setup_totp', 'totp', 'unknown', 'system', '0.0.0.0', 'failure', 'setup_flow');
                return res.status(401).json({ error: 'Invalid code.' });
            }

            // Finalize Enrollment: Create Identity and mark User as MFA Enabled
            const client = await req.projectPool!.connect();
            try {
                await client.query('BEGIN');
                await client.query(`INSERT INTO auth.identities (user_id, provider, identifier) VALUES ($1, 'totp', $2)`, [req.user.sub, secret]);
                await client.query(`UPDATE auth.users SET raw_user_meta_data = (raw_user_meta_data - 'totp_pending_secret') || '{"mfa_enabled": true}'::jsonb WHERE id = $1`, [req.user.sub]);
                await client.query('COMMIT');
                
                await AuthService.logAuthEvent(req.projectPool!, req.user.sub, 'setup_totp', 'totp', 'authenticator', 'system', '0.0.0.0', 'success', 'setup_flow');
                res.json({ success: true });
            } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        } catch (e: any) { next(e); }
    }

    static async getPolicies(req: CascataRequest, res: any, next: any) {
        try {
            const result = await req.projectPool!.query(`SELECT * FROM auth.policies ORDER BY priority DESC, created_at ASC`);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async savePolicy(req: CascataRequest, res: any, next: any) {
        const { id, name, priority, provider, origin, require_password, require_otp, require_user_mfa_choice, auto_login, active } = req.body;
        try {
            if (id) {
                // UPDATE
                await req.projectPool!.query(
                    `UPDATE auth.policies SET 
                        name = $1, priority = $2, provider = $3, origin = $4, 
                        require_password = $5, require_otp = $6, require_user_mfa_choice = $7, 
                        auto_login = $8, active = $9, updated_at = now() 
                     WHERE id = $10`,
                    [name, priority, provider, origin, require_password, require_otp, require_user_mfa_choice, auto_login, active, id]
                );
            } else {
                // INSERT
                await req.projectPool!.query(
                    `INSERT INTO auth.policies 
                        (name, priority, provider, origin, require_password, require_otp, require_user_mfa_choice, auto_login, active) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [name, priority, provider, origin, require_password, require_otp, require_user_mfa_choice, auto_login, active]
                );
            }
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async deletePolicy(req: CascataRequest, res: any, next: any) {
        const { id } = req.params;
        try {
            await req.projectPool!.query(`DELETE FROM auth.policies WHERE id = $1`, [id]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async panicRevoke(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') return res.status(403).json({ error: 'Access Denied: Panic Revocation requires Service Role.' });
        const { target_type, target_value, reason } = req.body;
        
        if (!['origin', 'user', 'provider'].includes(target_type) || !target_value) {
            return res.status(400).json({ error: 'Invalid target_type or target_value.' });
        }

        try {
            await req.projectPool!.query(
                `INSERT INTO auth.panic_revocations (target_type, target_value, metadata) VALUES ($1, $2, $3)`,
                [target_type, target_value, JSON.stringify({ reason: reason || 'Manual Admin Intervention' })]
            );

            // EMERGENCY ACTION: Neutralize sessions in REAL-TIME
            if (target_type === 'user') {
                const userRes = await req.projectPool!.query(`
                    SELECT u.id FROM auth.users u 
                    JOIN auth.identities i ON u.id = i.user_id 
                    WHERE i.identifier = $1 LIMIT 1
                `, [target_value]);
                const userId = userRes.rows[0]?.id;
                if (userId) {
                    await req.projectPool!.query(`UPDATE auth.refresh_tokens SET revoked = true WHERE user_id = $1`, [userId]);
                    await RateLimitService.setUserNeutralized(req.project.slug, userId, true);
                }
            } else if (target_type === 'global' || target_value === 'ALL') {
                await req.projectPool!.query(`UPDATE auth.refresh_tokens SET revoked = true`);
                await RateLimitService.setPanic(req.project.slug, true); // Active engine-wide lockdown
            }

            res.json({ success: true, message: `Panic Revocation issued and enforced for ${target_type}: ${target_value}` });
        } catch (e: any) { next(e); }
    }

    static async getAuditLogs(req: CascataRequest, res: any, next: any) {
        const { limit = 100, offset = 0 } = req.query;
        try {
            const result = await req.projectPool!.query(
                `SELECT * FROM auth.audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
                [limit, offset]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async getUserSessions(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: 'Access Denied: Only Service Role can query sessions directly.' });
        }
        try {
            const query = `
                SELECT id, user_agent, ip_address, created_at, expires_at 
                FROM auth.refresh_tokens 
                WHERE user_id = $1 AND revoked = false
                ORDER BY created_at DESC
            `;
            const result = await req.projectPool!.query(query, [req.params.id]);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async revokeOtherSessions(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: 'Access Denied: Only Service Role can revoke sessions.' });
        }
        const { current_session_id } = req.body;
        try {
            const query = `
                UPDATE auth.refresh_tokens 
                SET revoked = true 
                WHERE user_id = $1 AND id != $2 AND revoked = false
            `;
            await req.projectPool!.query(query, [req.params.id, current_session_id || '00000000-0000-0000-0000-000000000000']);
            res.json({ success: true, message: 'Other sessions revoked successfully.' });
        } catch (e: any) { next(e); }
    }

    static async revokeSession(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: 'Access Denied: Only Service Role can revoke sessions.' });
        }
        try {
            await req.projectPool!.query(`UPDATE auth.refresh_tokens SET revoked = true WHERE id = $1 AND user_id = $2`, [req.params.sessionId, req.params.id]);
            res.json({ success: true, message: 'Session revoked.' });
        } catch (e: any) { next(e); }
    }

    static async goTrueSignup(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        try {
            const language = req.body.language || 'en-US';
            const payload = { 
                ...req.body, 
                identifier: req.body.identifier || req.body.email,
                provider: req.body.provider || 'email',
                language 
            };
            res.json(await GoTrueService.handleSignup(req.projectPool!, payload, req.project.jwt_secret, req.project.metadata || {}, deviceInfo));
        } catch (e: any) { next(e); }
    }

    static async goTrueToken(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);

        // Supabase-JS e Flutterflow enviam grant_type pelo Query String (URL) e não no corpo (Body JSON)
        if (!req.body.grant_type && req.query.grant_type) {
            req.body.grant_type = req.query.grant_type;
        }

        const identifier = req.body.identifier || req.body.email;
        const provider = req.body.provider || 'email';
        const secConfig = DataAuthController.getSecurityConfig(req);
        try {
            if (req.body.grant_type === 'password') {
                const lockout = await RateLimitService.checkAuthLockout(req.project.slug, deviceInfo.ip!, identifier, secConfig);
                if (lockout.locked) return res.status(429).json({ error: lockout.reason });

                const neutralization = await DataAuthController.checkNeutralized(req, identifier);
                if (neutralization.neutralized) return res.status(401).json({ error: 'User access neutralized by Sovereign Panic Signal.', reason: neutralization.reason });

                const policy = await DataAuthController.evaluatePolicy(req, provider);
                if (policy && policy.active === false) return res.status(403).json({ error: 'Security Policy Block: Access path restricted by orchestrator.' });
            }

            req.body.language = req.body.language || 'en-US';
            req.body.identifier = identifier;
            req.body.provider = provider;

            const response = await GoTrueService.handleToken(req.projectPool!, req.body, req.project.jwt_secret, req.project.metadata || {}, deviceInfo);

            if (req.body.grant_type === 'password') await RateLimitService.clearAuthFailure(req.project.slug, deviceInfo.ip!, identifier);

            DataAuthController.setAuthCookies(res, response);
            res.json(response);
        } catch (e: any) {
            if (req.body.grant_type === 'password' && identifier) await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, identifier, secConfig);
            next(e);
        }
    }

    static async goTrueUser(req: CascataRequest, res: any, next: any) {
        if (!req.user?.sub) return res.status(401).json({ error: "unauthorized" });
        try { res.json(await GoTrueService.handleGetUser(req.projectPool!, req.user.sub)); } catch (e: any) { next(e); }
    }

    static async goTrueLogout(req: CascataRequest, res: any, next: any) {
        try {
            await GoTrueService.handleLogout(req.projectPool!, req.headers.authorization?.replace('Bearer ', '').trim() || '', req.project.jwt_secret);

            // Clear Cookies
            res.clearCookie('cascata_access_token', { path: '/' });
            res.clearCookie('cascata_refresh_token', { path: '/' });

            res.status(204).send();
        } catch (e) { next(e); }
    }

    static async goTrueVerify(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        try {
            const session = await GoTrueService.handleVerify(req.projectPool!, req.query.token as string, req.query.type as string, req.project.jwt_secret, req.project.metadata, deviceInfo);

            DataAuthController.setAuthCookies(res, session);

            const hash = `access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=${session.expires_in}&token_type=bearer&type=${req.query.type}`;
            const target = (req.query.redirect_to as string) || req.project.metadata?.auth_config?.site_url;
            if (target) res.redirect(`${target.endsWith('/') ? target.slice(0, -1) : target}#${hash}`);
            else res.json(session);
        } catch (e: any) { next(e); }
    }

    static async goTrueAuthorize(req: CascataRequest, res: any, next: any) {
        try {
            let providerName = req.query.provider as string;
            const prov = req.project.metadata?.auth_config?.providers?.[providerName];

            if (!prov?.client_id) throw new Error("Provider not configured.");

            const host = req.headers.host;
            const callbackUrl = req.project.custom_domain && host === req.project.custom_domain ? `https://${host}/auth/v1/callback` : `https://${host}/api/data/${req.project.slug}/auth/v1/callback`;

            const language = req.query.language || 'en-US';

            const state = Buffer.from(JSON.stringify({
                redirectTo: req.query.redirect_to || '',
                provider: providerName,
                client_id: req.appClient?.id || null, // Identity-Aware Key Bridging
                language: language
            })).toString('base64');

            res.redirect(AuthService.getAuthUrl(providerName, { clientId: prov.client_id, redirectUri: callbackUrl }, state));
        } catch (e: any) { next(e); }
    }

    static async goTrueCallback(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        try {
            let finalRedirect = '';
            let providerName = 'google';
            let requestClientId = null;

            try {
                const stateData = JSON.parse(Buffer.from(req.query.state as string, 'base64').toString('utf8'));
                finalRedirect = stateData.redirectTo;
                if (stateData.provider) providerName = stateData.provider;
                if (stateData.client_id) requestClientId = stateData.client_id;
            } catch (e) { }

            const prov = req.project.metadata?.auth_config?.providers?.[providerName];
            if (!prov) throw new Error(`Provider configuration for ${providerName} missing.`);

            const host = req.headers.host;
            const callbackUrl = req.project.custom_domain && host === req.project.custom_domain ? `https://${host}/auth/v1/callback` : `https://${host}/api/data/${req.project.slug}/auth/v1/callback`;

            const profile = await AuthService.handleCallback(providerName, req.query.code as string, { clientId: prov.client_id, clientSecret: prov.client_secret, redirectUri: callbackUrl });
            const userId = await AuthService.upsertUser(req.projectPool!, profile, req.project.metadata?.auth_config);

            const session = await AuthService.createSession(
                userId,
                req.projectPool!,
                req.project.jwt_secret,
                '1h',
                30,
                providerName,
                deviceInfo
            );

            DataAuthController.setAuthCookies(res, session);

            const hash = `access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=${session.expires_in}&token_type=bearer&type=recovery`;

            // --- IDENTITY-AWARE FALLBACK TARGET ---
            let fallbackSiteUrl = req.project.metadata?.auth_config?.site_url;
            if (requestClientId && req.project.metadata?.app_clients && Array.isArray(req.project.metadata.app_clients)) {
                const matchedClient = req.project.metadata.app_clients.find((c: any) => c.id === requestClientId);
                if (matchedClient && matchedClient.site_url) {
                    fallbackSiteUrl = matchedClient.site_url;
                }
            }

            if (finalRedirect || fallbackSiteUrl) {
                const target = finalRedirect || fallbackSiteUrl;
                res.redirect(`${target!.endsWith('/') ? target!.slice(0, -1) : target!}#${hash}`);
            } else {
                res.json(session);
            }

        } catch (e: any) { next(e); }
    }

    static async goTrueRecover(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        const secConfig = DataAuthController.getSecurityConfig(req);
        const identifier = req.body.identifier || req.body.email;
        const provider = req.body.provider || 'email';

        try {
            if (!identifier) return res.status(400).json({ error: "Identifier (or email) is required" });

            // FIREWALL: Recovery Throttling
            const lockout = await RateLimitService.checkAuthLockout(req.project.slug, deviceInfo.ip!, identifier, secConfig);
            if (lockout.locked) return res.status(429).json({ error: lockout.reason });

            const projectUrl = req.project.metadata?.auth_config?.site_url || `https://${req.headers.host}`;
            const emailConfig = req.project.metadata?.auth_config?.auth_strategies?.email || { delivery_method: 'smtp' };
            const language = req.body.language || 'en-US';

            await GoTrueService.handleRecover(
                req.projectPool!,
                identifier,
                provider,
                projectUrl,
                emailConfig,
                req.project.jwt_secret,
                req.project.metadata?.auth_config?.email_templates,
                language,
                req.project.metadata?.auth_config?.messaging_templates,
                req.project.metadata?.auth_config?.auth_strategies?.email?.template_bindings
            );

            res.json({ success: true, message: "If an account exists, a recovery instruction was sent." });
        } catch (e: any) {
            // Register failure for suspicious recovery spam
            if (identifier) await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, identifier, secConfig);
            next(e);
        }
    }

    private static maskIdentifier(provider: string, id: string): string {
        if (!id) return id;
        if (provider === 'email') {
            const parts = id.split('@');
            if (parts.length !== 2) return id;
            return parts[0].substring(0, 2) + '*'.repeat(Math.max(1, parts[0].length - 2)) + '@' + parts[1];
        }
        return '*'.repeat(Math.max(1, id.length - 3)) + id.substring(id.length - 3);
    }

    static async goTrueUpdateUser(req: CascataRequest, res: any, next: any) {
        if (!req.user?.sub) return res.status(401).json({ error: "unauthorized" });
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        try {
            const userId = req.user.sub;
            const provider = req.body.provider || 'email';
            const reqOtp = req.body.otp_code;
            const language = req.body.language || 'en-US';
            const messagingTemplates = req.project.metadata?.auth_config?.messaging_templates;

            // Check Project's specific configuration for this provider
            const strategies = req.project.metadata?.auth_strategies || {};
            const providerConfig = strategies[provider] || {};
            const dispatchMode = providerConfig.otp_dispatch_mode || 'delegated';

            // Bank-Grade Security Lock (Zero Trust OTP Validation for Password/Identity Linking) 
            if (providerConfig.require_otp_on_update === true) {
                let targetIdentifier = req.body.identifier || req.body.email;

                // If the user hasn't explicitly supplied an identifier to bind, we must query the DB 
                // to find their existing identifier for this provider to match against the OTP challenge table.
                if (!targetIdentifier) {
                    const identityCheck = await req.projectPool!.query(
                        `SELECT identifier FROM auth.identities WHERE user_id = $1 AND provider = $2`,
                        [userId, provider]
                    );

                    if (identityCheck.rows.length > 0) {
                        targetIdentifier = identityCheck.rows[0].identifier;
                    } else if (provider === 'email') {
                        // Fallback to internal user metadata email
                        const userCheck = await req.projectPool!.query(
                            `SELECT raw_user_meta_data->>'email' as email FROM auth.users WHERE id = $1`,
                            [userId]
                        );
                        targetIdentifier = userCheck.rows[0]?.email;
                    }
                }

                if (!reqOtp) {
                    // OTP is strictly required, let's process the Dispatch Routing

                    if (dispatchMode === 'delegated') {
                        const channels: any[] = [];
                        const idResult = await req.projectPool!.query(`SELECT provider, identifier FROM auth.identities WHERE user_id = $1`, [userId]);
                        idResult.rows.forEach((r: any) => {
                            channels.push({ provider: r.provider, identifier: DataAuthController.maskIdentifier(r.provider, r.identifier) });
                        });

                        if (!channels.find((c: any) => c.provider === 'email')) {
                            const userCheck = await req.projectPool!.query(`SELECT raw_user_meta_data->>'email' as email FROM auth.users WHERE id = $1`, [userId]);
                            if (userCheck.rows[0]?.email) {
                                channels.push({ provider: 'email', identifier: DataAuthController.maskIdentifier('email', userCheck.rows[0].email) });
                            }
                        }
                        return res.status(403).json({
                            error: "otp_required",
                            message: `Bank-Grade Lock activated. Please challenge an OTP code via /auth/challenge to one of your channels.`,
                            available_channels: channels
                        });
                    }

                    if (dispatchMode === 'auto_current') {
                        if (!targetIdentifier) return res.status(400).json({ error: `Cannot trigger auto_current OTP format for ${provider}: no target identifier specified or found in DB.` });
                        if (!providerConfig.webhook_url) return res.status(500).json({ error: `Missing webhook_url in '${provider}' config for auto_current dispatch.` });
                        await AuthService.initiatePasswordless(req.projectPool!, provider, targetIdentifier, providerConfig.webhook_url, req.project.jwt_secret, providerConfig.otp_config || { length: 6, charset: 'numeric' }, language, messagingTemplates, providerConfig.template_bindings);
                        return res.status(403).json({ error: "otp_dispatched", message: "OTP automatically dispatched to the current target.", channel: provider });
                    }

                    if (dispatchMode === 'auto_primary') {
                        const userCheck = await req.projectPool!.query(`SELECT raw_user_meta_data->>'email' as email FROM auth.users WHERE id = $1`, [userId]);
                        const primaryEmail = userCheck.rows[0]?.email;
                        if (!primaryEmail) return res.status(500).json({ error: "Sys: Cannot find root email for auto_primary dispatch." });
                        const emailCfg = strategies['email'] || {};
                        if (!emailCfg.webhook_url) return res.status(500).json({ error: "Missing webhook_url in 'email' config for auto_primary dispatch." });
                        await AuthService.initiatePasswordless(req.projectPool!, 'email', primaryEmail, emailCfg.webhook_url, req.project.jwt_secret, emailCfg.otp_config || { length: 6, charset: 'numeric' }, language, messagingTemplates, emailCfg.template_bindings);
                        return res.status(403).json({ error: "otp_dispatched", message: "OTP automatically dispatched to the root email account.", channel: "email" });
                    }
                }

                if (!targetIdentifier) {
                    throw new Error(`Cannot verify OTP. No identifier passed in request nor found internally for provider '${provider}'.`);
                }

                // If verifying against auto_primary, the challenge code was routed to the raw email
                let validationProvider = provider;
                let validationIdentifier = targetIdentifier;
                if (dispatchMode === 'auto_primary') {
                    validationProvider = 'email';
                    const userCheck = await req.projectPool!.query(`SELECT raw_user_meta_data->>'email' as email FROM auth.users WHERE id = $1`, [userId]);
                    validationIdentifier = userCheck.rows[0]?.email;
                }

                // Extremely secure verification (With built-in Timing-Attack defense)
                try {
                    await AuthService.verifyPasswordless(req.projectPool!, validationProvider, validationIdentifier, reqOtp);
                    // Clear failures on success
                    await RateLimitService.clearAuthFailure(req.project.slug, deviceInfo.ip!, validationIdentifier);
                } catch (err: any) {
                    // Register failure on OTP error within Bank-Grade lock
                    const secConfig = DataAuthController.getSecurityConfig(req);
                    await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, validationIdentifier, secConfig);
                    throw err;
                }
            }

            const updatedUser = await GoTrueService.handleUpdateUser(req.projectPool!, userId, req.body);
            res.json(updatedUser);
        } catch (e: any) { next(e); }
    }
}
