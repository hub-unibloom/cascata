
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { AuthService } from './AuthService.js';
import { WebhookService } from './WebhookService.js';
import { RateLimitService } from './RateLimitService.js';
import crypto from 'crypto';

interface GoTrueSignupParams {
    identifier: string;
    provider?: string;
    email?: string; // Legacy support
    password?: string;
    data?: any; // User metadata
}

interface GoTrueTokenParams {
    email?: string;
    identifier?: string;
    password?: string;
    refresh_token?: string;
    id_token?: string; // Google Token
    provider?: string;
    grant_type: 'password' | 'refresh_token' | 'id_token' | 'magic_link';
    token?: string; // For magic link
    language?: string; // I18N injection
    totp_code?: string; // Cascata specific MFA support
}

export class GoTrueService {

    public static async handleSignup(
        pool: Pool,
        params: any,
        jwtSecret: string,
        projectConfig: any,
        deviceInfo: { ip?: string, userAgent?: string, fingerprint?: string } = {}
    ) {
        const provider = params.provider || 'email';
        const identifier = params.identifier || params.email;
        const password = params.password;
        const data = params.data || {};

        if (!identifier) {
            throw new Error("Identifier is required");
        }

        const authConfig = projectConfig?.auth_config || {};
        const strategyConfig = authConfig.auth_strategies?.[provider] || {};
        
        // Strategy Decision: Is password mandatory for this signup?
        if (strategyConfig.password_required !== false && !password) {
             throw new Error("Password is required for this strategy.");
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // [A] Identity Check (Agnostic lookup)
            const check = await client.query(
                `SELECT u.id FROM auth.identities i JOIN auth.users u ON i.user_id = u.id WHERE i.provider = $1 AND i.identifier = $2`,
                [provider, identifier]
            );

            if (check.rows.length > 0) {
                const err: any = new Error("Identity already registered");
                err.code = "user_already_exists";
                await AuthService.logAuthEvent(pool, null, 'signup', provider, identifier, 'system', '0.0.0.0', 'failure', 'signup_flow', { error: 'user_already_exists' });
                throw err;
            }

            // [B] Metadata Splicing
            const meta = { ...data };
            if (provider === 'email' || identifier.includes('@')) {
                meta.email = identifier;
            }

            const requiresConfirmation = strategyConfig.confirmation === true;

            // [C] User Creation
            const userRes = await client.query(
                `INSERT INTO auth.users (raw_user_meta_data, created_at, last_sign_in_at, banned) 
                 VALUES ($1::jsonb, now(), now(), false) RETURNING *`,
                [JSON.stringify(meta)]
            );
            const user = userRes.rows[0];

            // [D] Identity Bind
            const passwordHash = password ? await bcrypt.hash(password, 10) : null;

            await client.query(
                `INSERT INTO auth.identities (user_id, provider, identifier, password_hash, identity_data, created_at, last_sign_in_at, verified_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, now(), now(), ${requiresConfirmation ? 'NULL' : 'now()'})`,
                [user.id, provider, identifier, passwordHash, JSON.stringify({ sub: user.id, ...meta })]
            );

            await client.query('COMMIT');

            const language = params.language || 'en-US';

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

                // If it's an email-based strategy, send confirmation email
                if (provider === 'email' || identifier.includes('@')) {
                    await AuthService.sendConfirmationEmail(
                        identifier,
                        token,
                        projectUrl,
                        strategyConfig || { delivery_method: 'smtp' },
                        authConfig.email_templates,
                        jwtSecret,
                        language,
                        authConfig.messaging_templates,
                        strategyConfig.template_bindings
                    );
                } else if (strategyConfig.webhook_url) {
                    // Agnostic Challenge: Dispatch Webhook for non-email identifiers
                    await AuthService.dispatchWebhook(strategyConfig.webhook_url, {
                        action: 'signup_confirmation',
                        provider,
                        identifier,
                        token,
                        projectUrl
                    }, jwtSecret);
                }

                return this.formatUserObject(user, []);
            }

            if (!requiresConfirmation && authConfig.send_welcome_email && (provider === 'email' || identifier.includes('@'))) {
                AuthService.sendWelcomeEmail(identifier, strategyConfig || { delivery_method: 'smtp' }, authConfig.email_templates, jwtSecret, language, authConfig.messaging_templates, strategyConfig.template_bindings).catch(e => console.error("Welcome Email Failed", e));
            }

            // Create session using the specific provider context
            const session = await AuthService.createSession(user.id, pool, jwtSecret, '1h', 30, provider, deviceInfo);
            await AuthService.logAuthEvent(pool, user.id, 'signup', provider, identifier, 'system', deviceInfo.ip || '0.0.0.0', 'success', 'signup_flow');
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
        projectConfig?: any,
        deviceInfo: { ip?: string, userAgent?: string, fingerprint?: string } = {}
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
                    `SELECT u.id, u.raw_user_meta_data->>'email' as email FROM auth.users u WHERE u.confirmation_token = $1`,
                    [token]
                );

                if (res.rows.length === 0) throw new Error("Invalid or expired confirmation token");

                const user = res.rows[0];
                userId = user.id;
                userEmail = user.email;

                // Set verified_at on the email identity (the source of truth)
                await client.query(
                    `UPDATE auth.identities SET verified_at = now() WHERE user_id = $1 AND provider = 'email' AND verified_at IS NULL`,
                    [userId]
                );

                // Clear confirmation token from users table
                await client.query(
                    `UPDATE auth.users SET confirmation_token = NULL WHERE id = $1`,
                    [userId]
                );

                // Send Welcome/Alerts for Signup
                if (projectConfig?.auth_config?.send_welcome_email && userEmail) {
                    const emailConfig = projectConfig.auth_config.auth_strategies?.email || { delivery_method: 'smtp' };
                    AuthService.sendWelcomeEmail(userEmail, emailConfig, projectConfig.auth_config.email_templates, jwtSecret).catch(() => { });
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

                // 5. Ensure identity is marked as verified (Implicit confirmation via magic link/recovery)
                await client.query(
                    `UPDATE auth.identities SET verified_at = now() WHERE user_id = $1 AND provider = 'email' AND verified_at IS NULL`,
                    [userId]
                );
            }

            await client.query('COMMIT');

            // Login Alert Logic (Applies to all verifications that result in a session)
            if (projectConfig?.auth_config?.send_login_alert && userEmail && type !== 'signup') {
                const emailConfig = projectConfig.auth_config.auth_strategies?.email || { delivery_method: 'smtp' };
                AuthService.sendLoginAlert(userEmail, emailConfig, projectConfig.auth_config.email_templates, jwtSecret).catch(() => { });
            }

            // Create Session for 'email' provider (since all verification flows here are email-based)
            const session = await AuthService.createSession(userId, pool, jwtSecret, '1h', 30, 'email', deviceInfo);
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
        identifier: string,
        provider: string,
        projectUrl: string,
        emailConfig: any,
        jwtSecret: string,
        templates?: any,
        language: string = 'en-US',
        messagingTemplates?: any,
        templateBindings?: any
    ) {
        if (!identifier) throw new Error("Identifier required");

        // Locate user via identity table using custom provider/identifier
        const userCheck = await pool.query(
            `SELECT user_id FROM auth.identities WHERE identifier = $1 AND provider = $2`,
            [identifier, provider]
        );

        if (userCheck.rows.length === 0) {
            return {};
        }

        // Send recovery (Currently mapped to email transport only, but technically triggers AuthService logic using the generic identifier)
        await AuthService.sendRecovery(pool, identifier, projectUrl, emailConfig, jwtSecret, templates, provider, language, messagingTemplates, templateBindings);
        return {};
    }

    public static async handleUpdateUser(pool: Pool, userId: string, data: { password?: string; provider?: string; identifier?: string; email?: string }) {
        if (!data.password) return {}; // We only handle password updates right now

        const passwordHash = await bcrypt.hash(data.password, 10);
        const provider = data.provider || 'email';

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Check if identity exists for this specific provider
            const identityRes = await client.query(
                `SELECT id, identifier FROM auth.identities WHERE user_id = $1 AND provider = $2`,
                [userId, provider]
            );

            if (identityRes.rows.length > 0) {
                // Identity exists -> Update its password hash
                await client.query(
                    `UPDATE auth.identities SET password_hash = $1, updated_at = now() WHERE id = $2`,
                    [passwordHash, identityRes.rows[0].id]
                );
            } else {
                // Identity doesn't exist -> we need to create it (Assign native login to social-only account)
                // Determine identifier from payload or fallback to users metadata email
                let identifier = data.identifier || data.email;

                if (!identifier && provider === 'email') {
                    const userRes = await client.query(`SELECT raw_user_meta_data->>'email' as email FROM auth.users WHERE id = $1`, [userId]);
                    identifier = userRes.rows[0]?.email;
                }

                if (!identifier) throw new Error("Identifier required to bind this password strategy.");

                await client.query(
                    `INSERT INTO auth.identities (user_id, provider, identifier, password_hash, created_at) VALUES ($1, $2, $3, $4, now())`,
                    [userId, provider, identifier, passwordHash]
                );
            }

            await client.query(`UPDATE auth.users SET updated_at = now() WHERE id = $1`, [userId]);
            await client.query('COMMIT');

            // Find user details to return (standard gotrue response shape)
            const updatedUser = await client.query(
                `SELECT id, raw_user_meta_data, banned FROM auth.users WHERE id = $1`, [userId]
            );
            return updatedUser.rows[0];
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    public static async handleMagicLink(
        pool: Pool,
        email: string,
        projectUrl: string,
        emailConfig: any,
        jwtSecret: string,
        templates?: any,
        authConfig?: any,
        language: string = 'en-US',
        messagingTemplates?: any,
        templateBindings?: any
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

        await AuthService.sendMagicLink(pool, email, projectUrl, emailConfig, jwtSecret, templates, 'email', language, messagingTemplates, templateBindings);
        return {};
    }

    public static async handleToken(
        pool: Pool,
        params: GoTrueTokenParams,
        jwtSecret: string,
        projectConfig: any,
        deviceInfo: { ip?: string, userAgent?: string, fingerprint?: string } = {}
    ) {
        const authConfig = projectConfig?.auth_config || {};

        if (params.grant_type === 'password') {
            const provider = params.provider || 'email';
            const identifier = params.identifier || params.email;

            if (!identifier || !params.password) throw new Error("Identifier and password required");

            const idRes = await pool.query(
                `SELECT * FROM auth.identities WHERE provider = $1 AND identifier = $2`,
                [provider, identifier]
            );

            if (idRes.rows.length === 0) throw new Error("Invalid login credentials");
            const identity = idRes.rows[0];

            const userCheck = await pool.query(`SELECT banned, raw_user_meta_data FROM auth.users WHERE id = $1`, [identity.user_id]);
            const user = userCheck.rows[0];

            if (user?.banned) throw new Error("Invalid login credentials");

            const strategyConfig = authConfig.auth_strategies?.[provider] || {};

            if ((strategyConfig.confirmation || authConfig.email_confirmation) && !identity.verified_at) {
                throw new Error("Identity not confirmed");
            }

            if (!identity.password_hash) {
                throw new Error("Invalid login credentials");
            }

            const match = await bcrypt.compare(params.password, identity.password_hash);
            if (!match) throw new Error("Invalid login credentials");

            if (params.grant_type === 'password') {
                await pool.query('UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1', [identity.user_id]);

                // ORCHESTRATION: Check for MFA (TOTP) within GoTrue bridge
                const totpIdRes = await pool.query(`SELECT identifier FROM auth.identities WHERE user_id = $1 AND provider = 'totp' LIMIT 1`, [identity.user_id]);
                if (totpIdRes.rows.length > 0) {
                    if (!params.totp_code) {
                        const err: any = new Error("MFA Code Required (TOTP)");
                        err.code = "mfa_required";
                        throw err;
                    }
                    const isValid = await AuthService.verifyTOTP(totpIdRes.rows[0].identifier, params.totp_code);
                    if (!isValid) {
                        await AuthService.logAuthEvent(pool, identity.user_id, 'login_gotrue', provider, identifier, 'system', deviceInfo.ip || '0.0.0.0', 'failure', 'gotrue_mfa', { error: 'invalid_totp' });
                        throw new Error("Invalid MFA Code");
                    }
                }
            }

            if (authConfig.login_webhook_url) {
                WebhookService.dispatch(
                    projectConfig.slug,
                    'auth.users',
                    'LOGIN',
                    { user_id: identity.user_id, identifier, provider, timestamp: new Date() },
                    pool,
                    jwtSecret
                ).catch(e => console.error("Login webhook failed", e));
            }

            if (authConfig.send_login_alert && (provider === 'email' || identifier.includes('@'))) {
                const emailConfig = authConfig.auth_strategies?.email || { delivery_method: 'smtp' };
                const language = params.language || 'en-US';
                AuthService.sendLoginAlert(identifier, emailConfig, authConfig.email_templates, jwtSecret, language, authConfig.messaging_templates, emailConfig.template_bindings).catch(() => { });
            }

            // Create session for the authenticated identity
            const session = await AuthService.createSession(identity.user_id, pool, jwtSecret, '1h', 30, provider, deviceInfo);
            await AuthService.logAuthEvent(pool, identity.user_id, 'login_gotrue', provider, identifier, 'system', deviceInfo.ip || '0.0.0.0', 'success', 'gotrue_flow');
            return this.formatSessionResponse(session);
        }

        if (params.grant_type === 'refresh_token') {
            if (!params.refresh_token) throw new Error("Refresh token required");
            // FINGERPRINTING: refreshSession now validates the current context against the token's birthplace
            const session = await AuthService.refreshSession(params.refresh_token, pool, jwtSecret, '1h', deviceInfo);
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

            const userId = await AuthService.upsertUser(pool, profile, authConfig);

            const userCheck = await pool.query(`SELECT banned FROM auth.users WHERE id = $1`, [userId]);
            if (userCheck.rows[0]?.banned) {
                throw new Error("User is banned");
            }

            if (authConfig.login_webhook_url) {
                WebhookService.dispatch(projectConfig.slug, 'auth.users', 'LOGIN', { user_id: userId, provider, timestamp: new Date() }, pool, jwtSecret).catch(() => { });
            }

            if (authConfig.send_login_alert && profile.email) {
                const emailConfig = authConfig.auth_strategies?.email || { delivery_method: 'smtp' };
                const language = params.language || 'en-US';
                AuthService.sendLoginAlert(profile.email, emailConfig, authConfig.email_templates, jwtSecret, language, authConfig.messaging_templates, emailConfig.template_bindings).catch(() => { });
            }

            // Create session for the specific social provider
            const session = await AuthService.createSession(userId, pool, jwtSecret, '1h', 30, provider, deviceInfo);
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
            const decoded: any = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
            if (!decoded || !decoded.sub) return;

            // Calculate remaining life of token
            const now = Math.floor(Date.now() / 1000);
            const ttl = decoded.exp - now;

            if (ttl > 0) {
                await RateLimitService.blacklistToken(token, ttl);
            }

            return true;
        } catch (e) {
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
                last_sign_in_at: new Date().toISOString()
            }, [])
        };
    }

    private static formatUserObject(user: any, identities: any[]) {
        // Derive the global confirmed_at from identities (first verified identity wins for legacy compat)
        const firstVerified = identities.find(i => i.verified_at);
        const confirmedAt = firstVerified?.verified_at || null;

        return {
            id: user.id,
            aud: "authenticated",
            role: "authenticated",
            email: user.email || user.raw_user_meta_data?.email,
            email_confirmed_at: confirmedAt,
            phone: "",
            confirmation_sent_at: user.confirmation_sent_at,
            confirmed_at: confirmedAt,
            last_sign_in_at: user.last_sign_in_at,
            app_metadata: {
                provider: identities[0]?.provider || "cascata",
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
                updated_at: i.updated_at || i.created_at,
                verified_at: i.verified_at
            })),
            created_at: user.created_at,
            updated_at: user.created_at
        };
    }
}
