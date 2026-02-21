
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
        return { ip, userAgent };
    }

    private static getSecurityConfig(req: CascataRequest): AuthSecurityConfig {
        const meta = req.project?.metadata?.auth_config?.security || {};
        return {
            max_attempts: meta.max_attempts || 5,
            lockout_minutes: meta.lockout_minutes || 15,
            strategy: meta.strategy || 'hybrid'
        };
    }

    static async listUsers(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        try {
            const result = await req.projectPool!.query(`SELECT u.id, u.created_at, u.banned, u.last_sign_in_at, u.email_confirmed_at, jsonb_agg(jsonb_build_object('id', i.id, 'provider', i.provider, 'identifier', i.identifier)) as identities FROM auth.users u LEFT JOIN auth.identities i ON u.id = i.user_id GROUP BY u.id ORDER BY u.created_at DESC`);
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
        const { provider, identifier, password } = req.body;
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        
        if (!provider || !identifier) {
            return res.status(400).json({ error: 'Provider and identifier are required.' });
        }

        const secConfig = DataAuthController.getSecurityConfig(req);
        const lockKey = `${provider}:${identifier}`; 

        try {
            const lockout = await RateLimitService.checkAuthLockout(req.project.slug, deviceInfo.ip!, lockKey, secConfig);
            if (lockout.locked) return res.status(429).json({ error: lockout.reason });
            
            const idRes = await req.projectPool!.query('SELECT * FROM auth.identities WHERE provider = $1 AND identifier = $2', [provider, identifier]);
            
            if (!idRes.rows[0]) {
                await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, lockKey, secConfig);
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            const identity = idRes.rows[0];
            const storedHash = identity.password_hash;
            
            if (!storedHash) {
                return res.status(400).json({ error: 'This identity does not support password login.' });
            }

            let isValid = storedHash.startsWith('$2') ? await bcrypt.compare(password, storedHash) : (storedHash === password);
            
            if (!isValid) {
                await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, lockKey, secConfig);
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            await RateLimitService.clearAuthFailure(req.project.slug, deviceInfo.ip!, lockKey);
            
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
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: 'Identity linking requires administrative privileges (Service Role).' });
        }
        const userId = req.params.id;
        try {
            const client = await req.projectPool!.connect();
            try {
                await client.query('BEGIN');
                const passwordHash = req.body.password ? await bcrypt.hash(req.body.password, 10) : null;
                await client.query('INSERT INTO auth.identities (user_id, provider, identifier, password_hash, created_at) VALUES ($1, $2, $3, $4, now())', [userId, req.body.provider, req.body.identifier, passwordHash]);
                await client.query('COMMIT');
                res.json({ success: true });
            } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        } catch (e: any) { next(e); }
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
            const metaUpdates = { auth_strategies: req.body.authStrategies, auth_config: req.body.authConfig, linked_tables: req.body.linked_tables };
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
            await AuthService.initiatePasswordless(req.projectPool!, req.body.provider, req.body.identifier, config.webhook_url, req.project.jwt_secret, config.otp_config || { length: 6, charset: 'numeric' });
            res.json({ success: true, message: 'Challenge sent' });
        } catch(e: any) { next(e); }
    }

    static async verifyChallenge(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        try {
            const profile = await AuthService.verifyPasswordless(req.projectPool!, req.body.provider, req.body.identifier, req.body.code);
            const userId = await AuthService.upsertUser(req.projectPool!, profile);
            
            const session = await AuthService.createSession(
                userId, 
                req.projectPool!, 
                req.project.jwt_secret, 
                '1h', 
                30, 
                req.body.provider,
                deviceInfo
            );
            
            DataAuthController.setAuthCookies(res, session);
            res.json(session);
        } catch(e: any) { next(e); }
    }

    static async goTrueSignup(req: CascataRequest, res: any, next: any) {
        try { res.json(await GoTrueService.handleSignup(req.projectPool!, req.body, req.project.jwt_secret, req.project.metadata || {})); } catch(e: any) { next(e); }
    }

    static async goTrueToken(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        const email = req.body.email;
        const secConfig = DataAuthController.getSecurityConfig(req);
        try {
            if (req.body.grant_type === 'password') {
                const lockout = await RateLimitService.checkAuthLockout(req.project.slug, deviceInfo.ip!, email, secConfig);
                if (lockout.locked) return res.status(429).json({ error: lockout.reason });
            }
            
            // GoTrueService doesn't accept deviceInfo yet for standard flow unless passed deep,
            // but we can augment it later or update GoTrueService separately.
            // For now, cookies are set here.
            
            const response = await GoTrueService.handleToken(req.projectPool!, req.body, req.project.jwt_secret, req.project.metadata || {});
            
            if (req.body.grant_type === 'password') await RateLimitService.clearAuthFailure(req.project.slug, deviceInfo.ip!, email);
            
            DataAuthController.setAuthCookies(res, response);
            res.json(response);
        } catch(e: any) {
            if (req.body.grant_type === 'password') await RateLimitService.registerAuthFailure(req.project.slug, deviceInfo.ip!, email, secConfig);
            next(e);
        }
    }

    static async goTrueUser(req: CascataRequest, res: any, next: any) {
        if (!req.user?.sub) return res.status(401).json({ error: "unauthorized" });
        try { res.json(await GoTrueService.handleGetUser(req.projectPool!, req.user.sub)); } catch(e: any) { next(e); }
    }

    static async goTrueLogout(req: CascataRequest, res: any, next: any) {
        try { 
            await GoTrueService.handleLogout(req.projectPool!, req.headers.authorization?.replace('Bearer ', '').trim() || '', req.project.jwt_secret);
            
            // Clear Cookies
            res.clearCookie('cascata_access_token', { path: '/' });
            res.clearCookie('cascata_refresh_token', { path: '/' });
            
            res.status(204).send(); 
        } catch(e) { next(e); }
    }

    static async goTrueVerify(req: CascataRequest, res: any, next: any) {
        try {
            const session = await GoTrueService.handleVerify(req.projectPool!, req.query.token as string, req.query.type as string, req.project.jwt_secret, req.project.metadata);
            
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
            
            const state = Buffer.from(JSON.stringify({ 
                redirectTo: req.query.redirect_to || '',
                provider: providerName 
            })).toString('base64');
            
            res.redirect(AuthService.getAuthUrl(providerName, { clientId: prov.client_id, redirectUri: callbackUrl }, state));
        } catch (e: any) { next(e); }
    }

    static async goTrueCallback(req: CascataRequest, res: any, next: any) {
        const deviceInfo = DataAuthController.getDeviceInfo(req);
        try {
            let finalRedirect = '';
            let providerName = 'google'; 

            try { 
                const stateData = JSON.parse(Buffer.from(req.query.state as string, 'base64').toString('utf8'));
                finalRedirect = stateData.redirectTo;
                if (stateData.provider) providerName = stateData.provider;
            } catch(e) {}

            const prov = req.project.metadata?.auth_config?.providers?.[providerName];
            if (!prov) throw new Error(`Provider configuration for ${providerName} missing.`);

            const host = req.headers.host;
            const callbackUrl = req.project.custom_domain && host === req.project.custom_domain ? `https://${host}/auth/v1/callback` : `https://${host}/api/data/${req.project.slug}/auth/v1/callback`;
            
            const profile = await AuthService.handleCallback(providerName, req.query.code as string, { clientId: prov.client_id, clientSecret: prov.client_secret, redirectUri: callbackUrl });
            const userId = await AuthService.upsertUser(req.projectPool!, profile);
            
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
            if (finalRedirect || req.project.metadata?.auth_config?.site_url) {
                const target = finalRedirect || req.project.metadata.auth_config.site_url;
                res.redirect(`${target.endsWith('/') ? target.slice(0, -1) : target}#${hash}`);
            } else res.json(session);
        } catch (e: any) { next(e); }
    }
}
