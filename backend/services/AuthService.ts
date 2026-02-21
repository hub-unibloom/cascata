
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { Buffer } from 'buffer';

interface ProviderConfig {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    webhookUrl?: string;
    authorized_clients?: string;
    skip_nonce?: boolean;
}

interface UserProfile {
    provider: string;
    id: string;
    email?: string;
    name?: string;
    avatar_url?: string;
}

interface SessionTokens {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user: {
        id: string;
        email?: string;
        app_metadata?: any;
        user_metadata?: any;
    };
}

interface OtpConfig {
    length?: number;
    charset?: 'numeric' | 'alphanumeric' | 'alpha' | 'hex';
    expiration_minutes?: number;
    regex_validation?: string;
}

interface EmailConfig {
    delivery_method: 'webhook' | 'resend' | 'smtp';
    webhook_url?: string;
    resend_api_key?: string;
    from_email?: string;
    smtp_host?: string;
    smtp_port?: string | number;
    smtp_user?: string;
    smtp_pass?: string;
    smtp_secure?: boolean;
}

interface EmailTemplates {
    confirmation?: { subject: string; body: string };
    recovery?: { subject: string; body: string };
    magic_link?: { subject: string; body: string };
    login_alert?: { subject: string; body: string };
    welcome_email?: { subject: string; body: string };
}

export class AuthService {

    /**
     * Valida um Google ID Token diretamente com o Google.
     */
    public static async verifyGoogleIdToken(idToken: string, config: ProviderConfig): Promise<UserProfile> {
        try {
            const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
            
            if (!res.ok) {
                throw new Error('Invalid Google ID Token');
            }

            const payload = await res.json();

            const mainClientId = config.clientId;
            const extraClientIds = (config.authorized_clients || '').split(',').map((s: string) => s.trim()).filter(Boolean);
            const allowedAudiences = [mainClientId, ...extraClientIds].filter(Boolean);

            if (allowedAudiences.length > 0 && !allowedAudiences.includes(payload.aud)) {
                throw new Error(`Token audience mismatch. Expected one of [${allowedAudiences.join(', ')}], got ${payload.aud}`);
            }

            return {
                provider: 'google',
                id: payload.sub,
                email: payload.email,
                name: payload.name,
                avatar_url: payload.picture
            };
        } catch (e: any) {
            console.error('[AuthService] Google Verification Failed:', e.message);
            throw new Error(`Unable to verify Google identity: ${e.message}`);
        }
    }

    public static getAuthUrl(provider: string, config: ProviderConfig, state: string): string {
        if (provider === 'google') {
            const root = 'https://accounts.google.com/o/oauth2/v2/auth';
            if (!config.clientId) throw new Error("Google Client ID missing");
            const nonce = crypto.randomBytes(16).toString('base64');
            const options = {
                redirect_uri: config.redirectUri || '',
                client_id: config.clientId,
                access_type: 'offline',
                response_type: 'code',
                prompt: 'consent',
                scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
                state,
                nonce
            };
            return `${root}?${new URLSearchParams(options).toString()}`;
        }
        
        if (provider === 'github') {
            const root = 'https://github.com/login/oauth/authorize';
            if (!config.clientId) throw new Error("GitHub Client ID missing");
            const options = {
                client_id: config.clientId,
                redirect_uri: config.redirectUri || '',
                scope: 'user:email',
                state
            };
            return `${root}?${new URLSearchParams(options).toString()}`;
        }

        throw new Error(`Provider ${provider} does not support OAuth URL generation.`);
    }

    public static async handleCallback(provider: string, code: string, config: ProviderConfig): Promise<UserProfile> {
        if (provider === 'google') {
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: config.clientId,
                    client_secret: config.clientSecret,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: config.redirectUri
                })
            });
            const tokens = await tokenRes.json();
            if (tokens.error) throw new Error(`Google Token Error: ${tokens.error_description}`);

            if (tokens.id_token) {
                 return this.verifyGoogleIdToken(tokens.id_token, config);
            }

            const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${tokens.access_token}` }
            });
            const profile = await profileRes.json();
            
            return {
                provider: 'google',
                id: profile.id,
                email: profile.email,
                name: profile.name,
                avatar_url: profile.picture
            };
        }

        if (provider === 'github') {
            const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({
                    client_id: config.clientId,
                    client_secret: config.clientSecret,
                    code,
                    redirect_uri: config.redirectUri
                })
            });
            const tokens = await tokenRes.json();
            if (tokens.error) throw new Error(`GitHub Token Error: ${tokens.error_description}`);

            const profileRes = await fetch('https://api.github.com/user', {
                headers: { Authorization: `Bearer ${tokens.access_token}` }
            });
            const profile = await profileRes.json();

            let email = profile.email;
            if (!email) {
                try {
                    const emailsRes = await fetch('https://api.github.com/user/emails', {
                        headers: { Authorization: `Bearer ${tokens.access_token}` }
                    });
                    const emails = await emailsRes.json();
                    if (Array.isArray(emails)) {
                        const primary = emails.find((e: any) => e.primary && e.verified);
                        if (primary) email = primary.email;
                    }
                } catch(e) {}
            }

            return {
                provider: 'github',
                id: String(profile.id),
                email: email,
                name: profile.name || profile.login,
                avatar_url: profile.avatar_url
            };
        }

        throw new Error(`Provider ${provider} not implemented in callback`);
    }

    private static async sendEmail(to: string, subject: string, htmlContent: string, config: EmailConfig, projectSecret: string, actionType: string) {
        const fromEmail = config.from_email || 'noreply@cascata.io';
        console.log(`[AuthService] Sending ${actionType} email to ${to} via ${config.delivery_method}`);

        if (config.delivery_method === 'webhook' && config.webhook_url) {
            await this.dispatchWebhook(config.webhook_url, {
                event: 'auth.email_request',
                action: actionType,
                to,
                from: fromEmail,
                subject,
                html: htmlContent,
                timestamp: new Date().toISOString()
            }, projectSecret);
            return;
        }

        if (config.delivery_method === 'resend' && config.resend_api_key) {
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${config.resend_api_key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: fromEmail, to: [to], subject: subject, html: htmlContent })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(`Resend API Error: ${err.message || 'Unknown error'}`);
            }
            return;
        }

        if (config.delivery_method === 'smtp') {
            if (!config.smtp_host || !config.smtp_user || !config.smtp_pass) {
                throw new Error("SMTP Credentials incomplete.");
            }
            const port = Number(config.smtp_port) || 587;
            const secure = config.smtp_secure || port === 465;
            const transporter = nodemailer.createTransport({
                host: config.smtp_host,
                port: port,
                secure: secure, 
                auth: { user: config.smtp_user, pass: config.smtp_pass },
            });
            try {
                await transporter.sendMail({ from: fromEmail, to, subject, html: htmlContent });
                return;
            } catch (smtpError: any) {
                throw new Error(`SMTP Handshake Failed: ${smtpError.message}`);
            }
        }
        console.warn(`[AuthService] No valid email provider configured. Simulating email to ${to}: ${subject}`);
    }

    private static replaceTemplate(template: string, data: Record<string, string>): string {
        let result = template;
        for (const key in data) {
            result = result.replace(new RegExp(`{{\\s*\\.${key}\\s*}}`, 'g'), data[key]);
            result = result.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), data[key]);
        }
        return result;
    }

    public static async sendConfirmationEmail(to: string, token: string, projectUrl: string, emailConfig: EmailConfig, templates: EmailTemplates | undefined, jwtSecret: string) {
        const actionUrl = `${projectUrl}/auth/v1/verify?token=${token}&type=signup&email=${encodeURIComponent(to)}`;
        let subject = "Confirm Your Email";
        let body = `<h2>Confirm your email</h2><p>Click the link below to confirm your email address:</p><p><a href="{{ .ConfirmationURL }}">Confirm Email</a></p>`;
        if (templates?.confirmation) {
            if (templates.confirmation.subject) subject = templates.confirmation.subject;
            if (templates.confirmation.body) body = templates.confirmation.body;
        }
        const html = this.replaceTemplate(body, { ConfirmationURL: actionUrl, Token: token, Email: to });
        await this.sendEmail(to, subject, html, emailConfig, jwtSecret, 'signup_confirmation');
    }

    public static async sendWelcomeEmail(to: string, emailConfig: EmailConfig, templates: EmailTemplates | undefined, jwtSecret: string) {
        let subject = "Welcome!";
        let body = `<h2>Welcome!</h2><p>We are excited to have you on board.</p>`;
        if (templates?.welcome_email) {
            if (templates.welcome_email.subject) subject = templates.welcome_email.subject;
            if (templates.welcome_email.body) body = templates.welcome_email.body;
        }
        const html = this.replaceTemplate(body, { Email: to, Date: new Date().toLocaleString() });
        await this.sendEmail(to, subject, html, emailConfig, jwtSecret, 'welcome_email');
    }

    public static async sendLoginAlert(to: string, emailConfig: EmailConfig, templates: EmailTemplates | undefined, jwtSecret: string) {
        let subject = "New Login Alert";
        let body = `<h2>New Login Detected</h2><p>We detected a new login to your account at {{ .Date }}.</p>`;
        if (templates?.login_alert) {
            if (templates.login_alert.subject) subject = templates.login_alert.subject;
            if (templates.login_alert.body) body = templates.login_alert.body;
        }
        const html = this.replaceTemplate(body, { Email: to, Date: new Date().toLocaleString() });
        await this.sendEmail(to, subject, html, emailConfig, jwtSecret, 'login_alert');
    }

    public static async sendMagicLink(pool: Pool, email: string, projectUrl: string, emailConfig: EmailConfig, jwtSecret: string, templates?: EmailTemplates) {
        return this.sendAuthLink(pool, email, projectUrl, emailConfig, jwtSecret, 'magiclink', templates);
    }

    public static async sendRecovery(pool: Pool, email: string, projectUrl: string, emailConfig: EmailConfig, jwtSecret: string, templates?: EmailTemplates) {
        return this.sendAuthLink(pool, email, projectUrl, emailConfig, jwtSecret, 'recovery', templates);
    }

    private static async sendAuthLink(pool: Pool, email: string, projectUrl: string, emailConfig: EmailConfig, jwtSecret: string, type: 'magiclink' | 'recovery', templates?: EmailTemplates) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expirationMinutes = 60;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`DELETE FROM auth.otp_codes WHERE identifier = $1 AND metadata->>'type' = $2`, [email, type]);
            await client.query(
                `INSERT INTO auth.otp_codes (provider, identifier, code, expires_at, metadata) VALUES ('email', $1, $2, now() + interval '${expirationMinutes} minutes', $3::jsonb)`,
                [email, tokenHash, JSON.stringify({ type, generated_at: new Date() })]
            );
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        const actionUrl = `${projectUrl}/auth/v1/verify?token=${token}&type=${type}&email=${encodeURIComponent(email)}`;
        let subject = type === 'magiclink' ? 'Your Login Link' : 'Reset Your Password';
        let body = type === 'magiclink' ? `<h2>Login Request</h2><p>Click here to login:</p><a href="{{ .ConfirmationURL }}">Sign In</a>` : `<h2>Reset Password</h2><p>Click here to reset your password:</p><a href="{{ .ConfirmationURL }}">Reset Password</a>`;

        if (type === 'magiclink' && templates?.magic_link) {
            if (templates.magic_link.subject) subject = templates.magic_link.subject;
            if (templates.magic_link.body) body = templates.magic_link.body;
        }
        if (type === 'recovery' && templates?.recovery) {
            if (templates.recovery.subject) subject = templates.recovery.subject;
            if (templates.recovery.body) body = templates.recovery.body;
        }

        const html = this.replaceTemplate(body, { ConfirmationURL: actionUrl, Token: token, Email: email });
        await this.sendEmail(email, subject, html, emailConfig, jwtSecret, type);
    }

    private static generateCode(config: OtpConfig): string {
        const length = config.length || 6;
        const charsetType = config.charset || 'numeric';
        let chars = '0123456789';
        if (charsetType === 'alpha') chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (charsetType === 'alphanumeric') chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (charsetType === 'hex') chars = '0123456789ABCDEF';
        const randomBytes = crypto.randomBytes(length);
        let result = '';
        for (let i = 0; i < length; i++) result += chars[randomBytes[i] % chars.length];
        return result;
    }

    private static validateIdentifier(identifier: string, regexPattern?: string): boolean {
        if (!regexPattern) return true;
        try {
            const regex = new RegExp(regexPattern);
            return regex.test(identifier);
        } catch (e) {
            console.warn('[AuthService] Invalid Regex Pattern in Config:', regexPattern);
            return true;
        }
    }

    public static async dispatchWebhook(webhookUrl: string, payload: any, secret: string) {
        const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
        try {
            const res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Cascata-Signature': signature, 'X-Cascata-Event': 'auth.challenge_request' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error(`Webhook failed with status ${res.status}`);
        } catch (e: any) {
            throw new Error(`Failed to send challenge via webhook transport.`);
        }
    }

    public static async initiatePasswordless(pool: Pool, provider: string, identifier: string, webhookUrl: string, serviceKey: string, otpConfig: OtpConfig = {}): Promise<void> {
        if (otpConfig.regex_validation) {
            const isValid = this.validateIdentifier(identifier, otpConfig.regex_validation);
            if (!isValid) throw new Error(`Invalid format for ${provider}. Please check your input.`);
        }
        const code = this.generateCode(otpConfig);
        const expirationMinutes = otpConfig.expiration_minutes || 15;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`DELETE FROM auth.otp_codes WHERE provider = $1 AND identifier = $2`, [provider, identifier]);
            await client.query(`INSERT INTO auth.otp_codes (provider, identifier, code, expires_at, metadata) VALUES ($1, $2, $3, now() + interval '${expirationMinutes} minutes', $4::jsonb)`, [provider, identifier, code, JSON.stringify({ generated_at: new Date(), format: otpConfig.charset })]);
            const payload = { action: 'send_challenge', strategy: provider, identifier, code, timestamp: new Date().toISOString(), meta: { expiration: `${expirationMinutes}m`, format: otpConfig.charset || 'numeric' } };
            await this.dispatchWebhook(webhookUrl, payload, serviceKey);
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    public static async verifyPasswordless(pool: Pool, provider: string, identifier: string, code: string, isHashCheck: boolean = false): Promise<UserProfile> {
        if (!provider || !identifier || !code) throw new Error("Missing verification parameters.");
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(`SELECT * FROM auth.otp_codes WHERE provider = $1 AND identifier = $2 AND expires_at > now()`, [provider, isHashCheck ? code : identifier]);
            if (res.rows.length === 0) throw new Error("Invalid or expired verification code.");
            const record = res.rows[0];
            if (record.attempts >= 5) {
                await client.query(`DELETE FROM auth.otp_codes WHERE id = $1`, [record.id]);
                await client.query('COMMIT');
                throw new Error("Too many failed attempts. Code revoked.");
            }

            // TIMING ATTACK PROTECTION
            const dbCode = Buffer.from(record.code);
            const userCode = Buffer.from(code);
            let match = true;
            if (dbCode.length !== userCode.length) {
                match = false;
                // Dummy comparison to equalize time
                crypto.timingSafeEqual(dbCode, dbCode); 
            } else {
                match = crypto.timingSafeEqual(dbCode, userCode);
            }

            if (!match) {
                await client.query(`UPDATE auth.otp_codes SET attempts = attempts + 1 WHERE id = $1`, [record.id]);
                await client.query('COMMIT');
                throw new Error("Invalid code.");
            }

            await client.query(`DELETE FROM auth.otp_codes WHERE id = $1`, [record.id]);
            await client.query('COMMIT');
            return { provider, id: identifier, email: identifier.includes('@') ? identifier : undefined, name: identifier };
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    public static async verifyMagicLinkToken(pool: Pool, email: string, token: string, type: string): Promise<UserProfile> {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(`SELECT * FROM auth.otp_codes WHERE provider = 'email' AND identifier = $1 AND metadata->>'type' = $2 AND expires_at > now()`, [tokenHash, type]);
            if (res.rows.length === 0) throw new Error("Invalid or expired link.");
            const record = res.rows[0];
            await client.query(`DELETE FROM auth.otp_codes WHERE id = $1`, [record.id]);
            await client.query('COMMIT');
            return { provider: 'email', id: email, email: email, name: email.split('@')[0] };
        } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    public static async upsertUser(projectPool: Pool, profile: UserProfile): Promise<string> {
        const client = await projectPool.connect();
        try {
            await client.query('BEGIN');
            const identityRes = await client.query(`SELECT user_id FROM auth.identities WHERE provider = $1 AND identifier = $2`, [profile.provider, profile.id]);
            let userId: string | null = null;
            if (identityRes.rows.length > 0) {
                userId = identityRes.rows[0].user_id;
                await client.query('UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1', [userId]);
                await client.query(`UPDATE auth.identities SET last_sign_in_at = now(), identity_data = $2::jsonb WHERE provider = $3 AND identifier = $4`, [userId, JSON.stringify(profile), profile.provider, profile.id]);
            } else {
                if (profile.email) {
                    const emailRes = await client.query(`SELECT id FROM auth.users WHERE raw_user_meta_data->>'email' = $1`, [profile.email]);
                    if (emailRes.rows.length > 0) userId = emailRes.rows[0].id;
                }
                if (!userId) {
                    const meta = { name: profile.name, avatar_url: profile.avatar_url, email: profile.email };
                    const newUserRes = await client.query(`INSERT INTO auth.users (raw_user_meta_data, created_at, last_sign_in_at, email_confirmed_at) VALUES ($1::jsonb, now(), now(), now()) RETURNING id`, [JSON.stringify(meta)]);
                    userId = newUserRes.rows[0].id;
                }
                await client.query(`INSERT INTO auth.identities (user_id, provider, identifier, identity_data, created_at, last_sign_in_at) VALUES ($1, $2, $3, $4::jsonb, now(), now())`, [userId, profile.provider, profile.id, JSON.stringify(profile)]);
            }
            if (userId) {
                const currentMetaRes = await client.query(`SELECT raw_user_meta_data FROM auth.users WHERE id = $1`, [userId]);
                const currentMeta = currentMetaRes.rows[0]?.raw_user_meta_data || {};
                const newMeta = { ...currentMeta, name: profile.name || currentMeta.name, avatar_url: profile.avatar_url || currentMeta.avatar_url, email: profile.email || currentMeta.email };
                await client.query(`UPDATE auth.users SET raw_user_meta_data = $1::jsonb WHERE id = $2`, [JSON.stringify(newMeta), userId]);
            }
            if (userId && profile.email && profile.provider !== 'email') {
                const checkEmailIdentity = await client.query(`SELECT 1 FROM auth.identities WHERE provider = 'email' AND user_id = $1`, [userId]);
                if (checkEmailIdentity.rowCount === 0) {
                    await client.query(`INSERT INTO auth.identities (user_id, provider, identifier, identity_data, created_at, last_sign_in_at) VALUES ($1, 'email', $2, $3::jsonb, now(), now())`, [userId, profile.email, JSON.stringify({ email: profile.email, sub: userId })]);
                }
            }
            await client.query('COMMIT');
            return userId as string;
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    public static async createSession(
        userId: string, 
        projectPool: Pool, 
        jwtSecret: string, 
        expiresIn: string = '1h', 
        refreshTokenExpiresInDays: number = 30,
        loginProvider: string = 'cascata',
        deviceInfo: { ip?: string, userAgent?: string } = {}
    ): Promise<SessionTokens> {
        
        // 1. Create JWT Payload
        const payload = { 
            sub: userId, 
            role: 'authenticated', 
            aud: 'authenticated',
            app_metadata: { 
                provider: loginProvider, 
                role: 'authenticated' 
            }
        };

        const accessToken = jwt.sign(payload, jwtSecret, { expiresIn: expiresIn as any });
        
        // 2. Generate Refresh Token
        const rawRefreshToken = crypto.randomBytes(40).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + refreshTokenExpiresInDays);
        
        // Insert with Fingerprint Metadata (Safe insertion even if columns missing due to dynamic migration handling)
        // We use dynamic query construction or just try/catch if column missing, but best is to rely on schema being up to date
        // Since we provided migration 027, we assume it runs.
        
        try {
            await projectPool.query(
                `INSERT INTO auth.refresh_tokens (token_hash, user_id, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)`, 
                [tokenHash, userId, expiresAt, deviceInfo.ip, deviceInfo.userAgent]
            );
        } catch (e: any) {
             // Fallback for systems without migration 027 applied yet
             if (e.code === '42703') { // Undefined column
                 await projectPool.query(
                    `INSERT INTO auth.refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, 
                    [tokenHash, userId, expiresAt]
                );
             } else {
                 throw e;
             }
        }
        
        const userRes = await projectPool.query(`SELECT id, raw_user_meta_data FROM auth.users WHERE id = $1`, [userId]);
        const user = userRes.rows[0];
        
        return { 
            access_token: accessToken, 
            refresh_token: rawRefreshToken, 
            expires_in: this.parseSeconds(expiresIn), 
            user: { 
                id: user.id, 
                email: user.raw_user_meta_data?.email, 
                user_metadata: user.raw_user_meta_data, 
                app_metadata: payload.app_metadata 
            } 
        };
    }

    public static async refreshSession(rawRefreshToken: string, projectPool: Pool, jwtSecret: string, expiresIn: string = '1h', deviceInfo: { ip?: string, userAgent?: string } = {}): Promise<SessionTokens> {
        const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
        const client = await projectPool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(`SELECT id, user_id, revoked, parent_token FROM auth.refresh_tokens WHERE token_hash = $1 AND expires_at > now()`, [tokenHash]);
            if (res.rows.length === 0) throw new Error("Invalid or expired refresh token");
            const oldToken = res.rows[0];
            if (oldToken.revoked) throw new Error("Token has been revoked (Reuse detected)");
            await client.query(`UPDATE auth.refresh_tokens SET revoked = true WHERE id = $1`, [oldToken.id]);
            
            const newRawRefreshToken = crypto.randomBytes(40).toString('hex');
            const newTokenHash = crypto.createHash('sha256').update(newRawRefreshToken).digest('hex');
            const newExpiresAt = new Date(); newExpiresAt.setDate(newExpiresAt.getDate() + 30);
            
            // Insert New Token with updated Fingerprint
            try {
                await client.query(
                    `INSERT INTO auth.refresh_tokens (token_hash, user_id, expires_at, parent_token, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`, 
                    [newTokenHash, oldToken.user_id, newExpiresAt, oldToken.id, deviceInfo.ip, deviceInfo.userAgent]
                );
            } catch(e: any) {
                 if (e.code === '42703') {
                     await client.query(
                        `INSERT INTO auth.refresh_tokens (token_hash, user_id, expires_at, parent_token) VALUES ($1, $2, $3, $4)`, 
                        [newTokenHash, oldToken.user_id, newExpiresAt, oldToken.id]
                    );
                 } else throw e;
            }

            const accessToken = jwt.sign({ sub: oldToken.user_id, role: 'authenticated', aud: 'authenticated' }, jwtSecret, { expiresIn: expiresIn as any });
            const userRes = await client.query(`SELECT id, raw_user_meta_data FROM auth.users WHERE id = $1`, [oldToken.user_id]);
            const user = userRes.rows[0];
            await client.query('COMMIT');
            return { access_token: accessToken, refresh_token: newRawRefreshToken, expires_in: this.parseSeconds(expiresIn), user: { id: user.id, email: user.raw_user_meta_data?.email, user_metadata: user.raw_user_meta_data, app_metadata: { provider: 'cascata', role: 'authenticated' } } };
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    private static parseSeconds(str: string): number {
        const match = str.match(/^(\d+)([smhd])$/);
        if (!match) return 3600;
        const val = parseInt(match[1]);
        const unit = match[2];
        if (unit === 's') return val;
        if (unit === 'm') return val * 60;
        if (unit === 'h') return val * 3600;
        if (unit === 'd') return val * 86400;
        return 3600;
    }
}
