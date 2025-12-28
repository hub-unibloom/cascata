import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

interface ProviderConfig {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    webhookUrl?: string; // New: For custom strategies
}

interface UserProfile {
    provider: string;
    id: string;
    email?: string; // Changed to optional for phone-only strategies
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

export class AuthService {

    /**
     * Generates the authorization URL for standard OAuth2 providers
     */
    public static getAuthUrl(provider: string, config: ProviderConfig, state: string): string {
        if (provider === 'google') {
            const root = 'https://accounts.google.com/o/oauth2/v2/auth';
            if (!config.clientId) throw new Error("Google Client ID missing");
            const options = {
                redirect_uri: config.redirectUri || '',
                client_id: config.clientId,
                access_type: 'offline',
                response_type: 'code',
                prompt: 'consent',
                scope: 'https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
                state
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

        throw new Error(`Provider ${provider} does not support OAuth URL generation. Use passwordless flow.`);
    }

    /**
     * Exchanges the authorization code for user profile (Standard OAuth2)
     */
    public static async handleCallback(provider: string, code: string, config: ProviderConfig): Promise<UserProfile> {
        if (provider === 'google') {
            // 1. Get Token
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

            // 2. Get Profile
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
            // 1. Get Token
            const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    client_id: config.clientId,
                    client_secret: config.clientSecret,
                    code,
                    redirect_uri: config.redirectUri
                })
            });
            const tokens = await tokenRes.json();
            if (tokens.error) throw new Error(`GitHub Token Error: ${tokens.error_description}`);

            // 2. Get Profile
            const profileRes = await fetch('https://api.github.com/user', {
                headers: { Authorization: `Bearer ${tokens.access_token}` }
            });
            const profile = await profileRes.json();

            // 3. Get Email (if private)
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

    // --- CUSTOM STRATEGY / PASSWORDLESS LOGIC ---

    public static generateOTP(length: number = 6): string {
        const chars = '0123456789';
        const randomBytes = crypto.randomBytes(length);
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars[randomBytes[i] % chars.length];
        }
        return result;
    }

    public static async dispatchWebhook(webhookUrl: string, payload: any, secret: string) {
        const signature = crypto.createHmac('sha256', secret)
            .update(JSON.stringify(payload))
            .digest('hex');

        try {
            const res = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Cascata-Signature': signature,
                    'X-Cascata-Event': 'auth.otp_request'
                },
                body: JSON.stringify(payload)
            });
            
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`Webhook failed with status ${res.status}: ${txt}`);
            }
        } catch (e: any) {
            console.error(`[AuthService] Webhook Dispatch Error: ${e.message}`);
            throw new Error(`Failed to send OTP via webhook: ${e.message}`);
        }
    }

    public static async initiatePasswordless(
        pool: Pool, 
        provider: string, 
        identifier: string, 
        webhookUrl: string, 
        serviceKey: string
    ): Promise<void> {
        const code = this.generateOTP();
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            await client.query(
                `DELETE FROM auth.otp_codes WHERE provider = $1 AND identifier = $2`,
                [provider, identifier]
            );
            await client.query(
                `INSERT INTO auth.otp_codes (provider, identifier, code, expires_at) 
                 VALUES ($1, $2, $3, now() + interval '15 minutes')`,
                [provider, identifier, code]
            );

            const payload = {
                action: 'login_otp',
                provider,
                identifier,
                code,
                timestamp: new Date().toISOString()
            };
            
            await this.dispatchWebhook(webhookUrl, payload, serviceKey);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    public static async verifyPasswordless(pool: Pool, provider: string, identifier: string, code: string): Promise<UserProfile> {
        const res = await pool.query(
            `SELECT * FROM auth.otp_codes 
             WHERE provider = $1 AND identifier = $2 AND code = $3 AND expires_at > now()`,
            [provider, identifier, code]
        );

        if (res.rows.length === 0) {
            throw new Error("Invalid or expired code.");
        }

        await pool.query(`DELETE FROM auth.otp_codes WHERE id = $1`, [res.rows[0].id]);

        return {
            provider,
            id: identifier, 
            email: identifier.includes('@') ? identifier : undefined,
            name: identifier 
        };
    }

    // --- SESSION & USER MANAGEMENT (ENHANCED) ---

    public static async upsertUser(projectPool: Pool, profile: UserProfile): Promise<string> {
        const client = await projectPool.connect();
        try {
            await client.query('BEGIN');

            const identityRes = await client.query(
                `SELECT user_id FROM auth.identities WHERE provider = $1 AND identifier = $2`,
                [profile.provider, profile.id]
            );

            if (identityRes.rows.length > 0) {
                const userId = identityRes.rows[0].user_id;
                await client.query('UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1', [userId]);
                await client.query(
                    `UPDATE auth.identities 
                     SET last_sign_in_at = now(), identity_data = $2 
                     WHERE provider = $3 AND identifier = $4`, 
                    [userId, JSON.stringify(profile), profile.provider, profile.id]
                );
                await client.query('COMMIT');
                return userId;
            }

            let userId: string | null = null;

            if (profile.email) {
                const emailRes = await client.query(
                    `SELECT id FROM auth.users WHERE raw_user_meta_data->>'email' = $1`,
                    [profile.email]
                );
                if (emailRes.rows.length > 0) {
                    userId = emailRes.rows[0].id;
                }
            }

            if (!userId) {
                const meta = { 
                    name: profile.name, 
                    avatar_url: profile.avatar_url,
                    email: profile.email
                };
                
                const newUserRes = await client.query(
                    `INSERT INTO auth.users (raw_user_meta_data, created_at, last_sign_in_at) 
                     VALUES ($1, now(), now()) RETURNING id`,
                    [JSON.stringify(meta)]
                );
                userId = newUserRes.rows[0].id;
            }

            await client.query(
                `INSERT INTO auth.identities (user_id, provider, identifier, identity_data, created_at, last_sign_in_at)
                 VALUES ($1, $2, $3, $4, now(), now())`,
                [userId, profile.provider, profile.id, JSON.stringify(profile)]
            );

            await client.query('COMMIT');
            return userId as string;

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    /**
     * Creates a full session with Access Token and Refresh Token.
     * Uses SHA-256 for Refresh Token storage (secure) and returns the raw token to the user.
     * @param userId The User ID (UUID)
     * @param projectPool Database Connection
     * @param jwtSecret Project JWT Secret
     * @param expiresIn Access Token expiration (e.g., '1h', '15m')
     * @param refreshTokenExpiresInDays Refresh Token validity (e.g., 30)
     */
    public static async createSession(
        userId: string,
        projectPool: Pool,
        jwtSecret: string,
        expiresIn: string = '1h',
        refreshTokenExpiresInDays: number = 30
    ): Promise<SessionTokens> {
        // 1. Generate Access Token (JWT)
        const accessToken = jwt.sign(
            { 
                sub: userId, 
                role: 'authenticated',
                aud: 'authenticated'
            }, 
            jwtSecret, 
            { expiresIn: expiresIn as any }
        );

        // 2. Generate Refresh Token (Opaque)
        const rawRefreshToken = crypto.randomBytes(40).toString('hex');
        
        // 3. Hash Refresh Token for Storage
        // We use SHA256 for speed/security balance on tokens (bcrypt is too slow for high-traffic session checks)
        const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

        // 4. Store in DB
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + refreshTokenExpiresInDays);

        await projectPool.query(
            `INSERT INTO auth.refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
            [tokenHash, userId, expiresAt]
        );

        // 5. Get User Data for response
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
                app_metadata: { provider: 'cascata', role: 'authenticated' }
            }
        };
    }

    /**
     * Exchanges a Refresh Token for a new Pair (Rotation).
     */
    public static async refreshSession(
        rawRefreshToken: string,
        projectPool: Pool,
        jwtSecret: string,
        expiresIn: string = '1h'
    ): Promise<SessionTokens> {
        const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

        const client = await projectPool.connect();
        try {
            await client.query('BEGIN');

            // 1. Find Token (Valid, Not Revoked, Not Expired)
            const res = await client.query(
                `SELECT id, user_id, revoked, parent_token FROM auth.refresh_tokens 
                 WHERE token_hash = $1 AND expires_at > now()`,
                [tokenHash]
            );

            if (res.rows.length === 0) {
                // If token not found, it might be a Reuse Attack (Token was already rotated/deleted)
                // In strict mode, we should flag the user or revoke all their tokens.
                throw new Error("Invalid or expired refresh token");
            }

            const oldToken = res.rows[0];

            if (oldToken.revoked) {
                // Reuse Detection: Revoke the whole family (if we tracked families strictly)
                // For now, simple rejection.
                throw new Error("Token has been revoked (Reuse detected)");
            }

            // 2. Revoke Old Token (Rotation)
            await client.query(`UPDATE auth.refresh_tokens SET revoked = true WHERE id = $1`, [oldToken.id]);

            // 3. Issue New Tokens
            // Inherit expiration from strategy config passed in (or default) - here we assume fresh 30 days or carry over.
            // Let's reset to 30 days for active users.
            const newRawRefreshToken = crypto.randomBytes(40).toString('hex');
            const newTokenHash = crypto.createHash('sha256').update(newRawRefreshToken).digest('hex');
            const newExpiresAt = new Date();
            newExpiresAt.setDate(newExpiresAt.getDate() + 30);

            await client.query(
                `INSERT INTO auth.refresh_tokens (token_hash, user_id, expires_at, parent_token) 
                 VALUES ($1, $2, $3, $4)`,
                [newTokenHash, oldToken.user_id, newExpiresAt, oldToken.id]
            );

            const accessToken = jwt.sign(
                { sub: oldToken.user_id, role: 'authenticated', aud: 'authenticated' }, 
                jwtSecret, 
                { expiresIn: expiresIn as any }
            );

            // 4. Get User Info
            const userRes = await client.query(`SELECT id, raw_user_meta_data FROM auth.users WHERE id = $1`, [oldToken.user_id]);
            const user = userRes.rows[0];

            await client.query('COMMIT');

            return {
                access_token: accessToken,
                refresh_token: newRawRefreshToken,
                expires_in: this.parseSeconds(expiresIn),
                user: {
                    id: user.id,
                    email: user.raw_user_meta_data?.email,
                    user_metadata: user.raw_user_meta_data,
                    app_metadata: { provider: 'cascata', role: 'authenticated' }
                }
            };

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
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