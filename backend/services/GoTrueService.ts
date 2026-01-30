
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { AuthService } from './AuthService.js';
import { WebhookService } from './WebhookService.js';
import { RateLimitService } from './RateLimitService.js';
import crypto from 'crypto';

interface GoTrueSignupParams {
    email: string;
    password: string;
    data?: any; // User metadata
}

interface GoTrueTokenParams {
    email?: string;
    password?: string;
    refresh_token?: string;
    id_token?: string; // Google Token
    provider?: string;
    grant_type: 'password' | 'refresh_token' | 'id_token' | 'magic_link';
    token?: string; // For magic link
}

export class GoTrueService {

    public static async handleSignup(
        pool: Pool, 
        params: any, 
        jwtSecret: string,
        projectConfig: any 
    ) {
        const { email, password, data } = params;

        if (!email || !password) {
            throw new Error("Email and password required");
        }
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const check = await client.query(
                `SELECT id FROM auth.users WHERE raw_user_meta_data->>'email' = $1`, 
                [email]
            );

            if (check.rows.length > 0) {
                const err: any = new Error("User already registered");
                err.code = "user_already_exists"; 
                throw err;
            }

            const meta = { email, ...(data || {}) };
            const authConfig = projectConfig?.auth_config || {};
            const requiresConfirmation = authConfig.email_confirmation === true;
            
            const confirmedAt = requiresConfirmation ? null : 'now()';

            const userRes = await client.query(
                `INSERT INTO auth.users (raw_user_meta_data, created_at, last_sign_in_at, banned, email_confirmed_at) 
                 VALUES ($1::jsonb, now(), now(), false, ${confirmedAt}) RETURNING *`,
                [JSON.stringify(meta)]
            );
            const user = userRes.rows[0];

            const passwordHash = await bcrypt.hash(password, 10);
            
            await client.query(
                `INSERT INTO auth.identities (user_id, provider, identifier, password_hash, identity_data, created_at, last_sign_in_at)
                 VALUES ($1, 'email', $2, $3, $4::jsonb, now(), now())`,
                [user.id, email, passwordHash, JSON.stringify({ sub: user.id, email })]
            );

            await client.query('COMMIT');

            const emailConfig = authConfig.auth_strategies?.email || { delivery_method: 'smtp' }; 

            if (requiresConfirmation) {
                const token = crypto.randomBytes(32).toString('hex');
                
                await pool.query(
                    `UPDATE auth.users SET confirmation_token = $1, confirmation_sent_at = now() WHERE id = $2`,
                    [token, user.id]
                );

                let projectUrl = projectConfig?.custom_domain 
                    ? `https://${projectConfig.custom_domain}` 
                    : `http://${process.env.APP_HOST || 'localhost'}/api/data/${projectConfig.slug}`;
                
                if (authConfig.site_url) {
                    projectUrl = authConfig.site_url.replace(/\/$/, '');
                }

                await AuthService.sendConfirmationEmail(
                    email, 
                    token, 
                    projectUrl, 
                    emailConfig, 
                    authConfig.email_templates,
                    jwtSecret
                );

                return this.formatUserObject(user, []); 
            }

            if (!requiresConfirmation && authConfig.send_welcome_email) {
                 AuthService.sendWelcomeEmail(email, emailConfig, authConfig.email_templates, jwtSecret).catch(e => console.error("Welcome Email Failed", e));
            }

            // Create session for 'email' provider
            const session = await AuthService.createSession(user.id, pool, jwtSecret, '1h', 30, 'email');
            return this.formatSessionResponse(session);

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    public static async handleVerify(
        pool: Pool, 
        token: string, 
        type: string, 
        jwtSecret: string,
        projectConfig?: any 
    ) {
        // Supported flows: signup (confirmation), recovery (password reset), magiclink (login), invite
        if (!['signup', 'recovery', 'magiclink', 'invite'].includes(type)) {
            throw new Error("Invalid verification type");
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            let userId;
            let userEmail;

            if (type === 'signup') {
                const res = await client.query(
                    `SELECT id, email_confirmed_at, raw_user_meta_data->>'email' as email FROM auth.users WHERE confirmation_token = $1`,
                    [token]
                );

                if (res.rows.length === 0) throw new Error("Invalid or expired confirmation token");
                
                const user = res.rows[0];
                userId = user.id;
                userEmail = user.email;

                await client.query(
                    `UPDATE auth.users 
                     SET email_confirmed_at = now(), confirmation_token = NULL 
                     WHERE id = $1`,
                    [userId]
                );

                // Send Welcome/Alerts for Signup
                if (projectConfig?.auth_config?.send_welcome_email && userEmail) {
                    const emailConfig = projectConfig.auth_config.auth_strategies?.email || { delivery_method: 'smtp' };
                    AuthService.sendWelcomeEmail(userEmail, emailConfig, projectConfig.auth_config.email_templates, jwtSecret).catch(() => {});
                }

            } else if (type === 'recovery' || type === 'magiclink' || type === 'invite') {
                // Bridge to AuthService OTP Logic
                // 1. Hash the incoming token to match database storage
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

                // 2. Lookup in auth.otp_codes (Where AuthLinks are stored)
                // We check against provider='email' and ensure the type matches via metadata
                const otpRes = await client.query(
                    `SELECT * FROM auth.otp_codes 
                     WHERE code = $1 
                     AND provider = 'email'
                     AND (metadata->>'type' = $2 OR metadata->>'type' IS NULL) 
                     AND expires_at > now()`,
                    [tokenHash, type === 'invite' ? 'invite' : (type === 'recovery' ? 'recovery' : 'magiclink')]
                );

                if (otpRes.rows.length === 0) {
                    throw new Error("Invalid or expired verification link.");
                }

                const otpRecord = otpRes.rows[0];
                const identifier = otpRecord.identifier; // Email

                // 3. Find User
                const userRes = await client.query(
                    `SELECT id, raw_user_meta_data->>'email' as email FROM auth.users WHERE raw_user_meta_data->>'email' = $1`,
                    [identifier]
                );

                if (userRes.rows.length === 0) throw new Error("User not found.");
                
                const user = userRes.rows[0];
                userId = user.id;
                userEmail = user.email;

                // 4. Consume Token (One-time use)
                await client.query(`DELETE FROM auth.otp_codes WHERE id = $1`, [otpRecord.id]);

                // 5. Ensure Email is Confirmed (Implicit confirmation via magic link/recovery)
                await client.query(
                    `UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1 AND email_confirmed_at IS NULL`,
                    [userId]
                );
            } 

            await client.query('COMMIT');
            
            // Login Alert Logic (Applies to all verifications that result in a session)
            if (projectConfig?.auth_config?.send_login_alert && userEmail && type !== 'signup') {
                const emailConfig = projectConfig.auth_config.auth_strategies?.email || { delivery_method: 'smtp' };
                AuthService.sendLoginAlert(userEmail, emailConfig, projectConfig.auth_config.email_templates, jwtSecret).catch(() => {});
            }

            // Create Session for 'email' provider (since all verification flows here are email-based)
            const session = await AuthService.createSession(userId, pool, jwtSecret, '1h', 30, 'email');
            return session;

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    public static async handleRecover(
        pool: Pool,
        email: string,
        projectUrl: string, 
        emailConfig: any, 
        jwtSecret: string,
        templates?: any
    ) {
        if (!email) throw new Error("Email required");

        const userCheck = await pool.query(
            `SELECT id FROM auth.users WHERE raw_user_meta_data->>'email' = $1`, 
            [email]
        );
        
        if (userCheck.rows.length === 0) {
            return {};
        }

        await AuthService.sendRecovery(pool, email, projectUrl, emailConfig, jwtSecret, templates);
        return {}; 
    }

    public static async handleMagicLink(
        pool: Pool,
        email: string,
        projectUrl: string,
        emailConfig: any,
        jwtSecret: string,
        templates?: any,
        authConfig?: any 
    ) {
        if (!email) throw new Error("Email required");
        
        if (authConfig?.disable_magic_link) {
            throw new Error("Magic Link login is disabled for this project.");
        }

        const userCheck = await pool.query(
            `SELECT id FROM auth.users WHERE raw_user_meta_data->>'email' = $1`, 
            [email]
        );
        
        // PRIVACY SHIELD: Retornar sucesso falso se usuário não existir (Timing Attack prevention)
        if (userCheck.rows.length === 0) {
             // Simular delay para evitar enumeração
             await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
             return {};
        }

        await AuthService.sendMagicLink(pool, email, projectUrl, emailConfig, jwtSecret, templates);
        return {};
    }

    public static async handleToken(
        pool: Pool,
        params: GoTrueTokenParams,
        jwtSecret: string,
        projectConfig: any 
    ) {
        const authConfig = projectConfig?.auth_config || {};

        if (params.grant_type === 'password') {
            if (!params.email || !params.password) throw new Error("Email and password required");
            
            const idRes = await pool.query(
                `SELECT * FROM auth.identities WHERE provider = 'email' AND identifier = $1`,
                [params.email]
            );

            if (idRes.rows.length === 0) throw new Error("Invalid login credentials");
            const identity = idRes.rows[0];

            const userCheck = await pool.query(`SELECT banned, email_confirmed_at, raw_user_meta_data FROM auth.users WHERE id = $1`, [identity.user_id]);
            const user = userCheck.rows[0];
            
            if (user?.banned) throw new Error("Invalid login credentials"); 
            
            if (authConfig.email_confirmation && !user.email_confirmed_at) {
                throw new Error("Email not confirmed");
            }

            const match = await bcrypt.compare(params.password, identity.password_hash);
            if (!match) throw new Error("Invalid login credentials");

            await pool.query('UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1', [identity.user_id]);

            if (authConfig.login_webhook_url) {
                WebhookService.dispatch(
                    projectConfig.slug, 
                    'auth.users', 
                    'LOGIN', 
                    { user_id: identity.user_id, email: params.email, timestamp: new Date() }, 
                    pool, 
                    jwtSecret 
                ).catch(e => console.error("Login webhook failed", e));
            }

            if (authConfig.send_login_alert && params.email) {
                const emailConfig = authConfig.auth_strategies?.email || { delivery_method: 'smtp' };
                AuthService.sendLoginAlert(params.email, emailConfig, authConfig.email_templates, jwtSecret).catch(() => {});
            }

            // Create session for 'email'
            const session = await AuthService.createSession(identity.user_id, pool, jwtSecret, '1h', 30, 'email');
            return this.formatSessionResponse(session);
        }

        if (params.grant_type === 'refresh_token') {
            if (!params.refresh_token) throw new Error("Refresh token required");
            // refreshSession maintains the original provider logic implicitly through session recreation or we assume 'cascata' if not tracked
            const session = await AuthService.refreshSession(params.refresh_token, pool, jwtSecret);
            return this.formatSessionResponse(session);
        }

        if (params.grant_type === 'id_token') {
            const provider = params.provider;
            const idToken = params.id_token;

            if (!idToken || !provider) throw new Error("id_token and provider required");

            let profile;
            if (provider === 'google') {
                const googleConfig = authConfig.providers?.google;
                if (!googleConfig) throw new Error("Google provider not configured");
                
                profile = await AuthService.verifyGoogleIdToken(idToken, googleConfig);
            } else {
                throw new Error(`Provider ${provider} not supported for id_token flow yet`);
            }

            const userId = await AuthService.upsertUser(pool, profile);
            
            const userCheck = await pool.query(`SELECT banned FROM auth.users WHERE id = $1`, [userId]);
            if (userCheck.rows[0]?.banned) {
                 throw new Error("User is banned"); 
            }

            if (authConfig.login_webhook_url) {
                WebhookService.dispatch(projectConfig.slug, 'auth.users', 'LOGIN', { user_id: userId, provider, timestamp: new Date() }, pool, jwtSecret).catch(() => {});
            }

            if (authConfig.send_login_alert && profile.email) {
                const emailConfig = authConfig.auth_strategies?.email || { delivery_method: 'smtp' };
                AuthService.sendLoginAlert(profile.email, emailConfig, authConfig.email_templates, jwtSecret).catch(() => {});
            }
            
            // Create session for the specific social provider
            const session = await AuthService.createSession(userId, pool, jwtSecret, '1h', 30, provider);
            return this.formatSessionResponse(session);
        }

        throw new Error("Unsupported grant_type");
    }

    public static async handleGetUser(pool: Pool, userId: string) {
        const res = await pool.query(`SELECT * FROM auth.users WHERE id = $1`, [userId]);
        if (res.rows.length === 0) throw new Error("User not found");
        
        const user = res.rows[0];
        const identitiesRes = await pool.query(`SELECT * FROM auth.identities WHERE user_id = $1`, [userId]);
        
        return this.formatUserObject(user, identitiesRes.rows);
    }

    /**
     * SECURE LOGOUT (Blacklist JTI)
     */
    public static async handleLogout(pool: Pool, token: string, jwtSecret: string) {
        try {
            const decoded: any = jwt.verify(token, jwtSecret);
            if (!decoded || !decoded.sub) return;

            // Calculate remaining life of token
            const now = Math.floor(Date.now() / 1000);
            const ttl = decoded.exp - now;

            if (ttl > 0) {
                await RateLimitService.blacklistToken(token, ttl);
            }
            
            return true;
        } catch(e) {
            return true; // If token invalid, consider logged out
        }
    }

    // --- HELPERS ---

    private static formatSessionResponse(session: any) {
        const currentSeconds = Math.floor(Date.now() / 1000);
        const expiresAt = currentSeconds + session.expires_in;

        return {
            access_token: session.access_token,
            token_type: "bearer",
            expires_in: session.expires_in,
            expires_at: expiresAt,
            refresh_token: session.refresh_token,
            user: this.formatUserObject({
                id: session.user.id,
                raw_user_meta_data: session.user.user_metadata,
                created_at: new Date().toISOString(),
                last_sign_in_at: new Date().toISOString(),
                email: session.user.email,
                email_confirmed_at: new Date().toISOString() 
            }, []) 
        };
    }

    private static formatUserObject(user: any, identities: any[]) {
        return {
            id: user.id,
            aud: "authenticated",
            role: "authenticated",
            email: user.email || user.raw_user_meta_data?.email,
            email_confirmed_at: user.email_confirmed_at,
            phone: "",
            confirmation_sent_at: user.confirmation_sent_at,
            confirmed_at: user.email_confirmed_at,
            last_sign_in_at: user.last_sign_in_at,
            app_metadata: {
                provider: "email",
                providers: identities.map(i => i.provider)
            },
            user_metadata: user.raw_user_meta_data || {},
            identities: identities.map(i => ({
                id: i.id,
                user_id: i.user_id,
                identity_data: i.identity_data,
                provider: i.provider,
                last_sign_in_at: i.last_sign_in_at,
                created_at: i.created_at,
                updated_at: i.created_at
            })),
            created_at: user.created_at,
            updated_at: user.created_at
        };
    }
}
