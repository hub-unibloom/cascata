
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import axios from 'axios';

interface FcmConfig {
    project_id: string;
    client_email: string;
    private_key: string;
}

/**
 * PushProcessor
 * Isolates the logic for sending messages to FCM/Google.
 * Does NOT import QueueService, breaking the circular dependency chain.
 */
export class PushProcessor {
    
    private static getAccessToken(config: FcmConfig): string {
        const now = Math.floor(Date.now() / 1000);
        const claim = {
            iss: config.client_email,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: "https://oauth2.googleapis.com/token",
            exp: now + 3600,
            iat: now
        };
        return jwt.sign(claim, config.private_key, { algorithm: 'RS256' });
    }

    public static async processDelivery(pool: Pool, systemPool: Pool, projectSlug: string, userId: string, notification: any, fcmConfig: FcmConfig) {
        // 1. Fetch active devices
        const devicesRes = await pool.query(`SELECT token, platform FROM auth.user_devices WHERE user_id = $1 AND is_active = true`, [userId]);
        if (devicesRes.rows.length === 0) return { success: false, reason: 'no_devices' };

        // 2. Get Google Auth Token
        const signedJwt = this.getAccessToken(fcmConfig);
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: signedJwt
        });
        const googleAccessToken = tokenRes.data.access_token;

        // 3. Send to all devices
        const results = await Promise.all(devicesRes.rows.map(async (device) => {
            const messagePayload = {
                message: {
                    token: device.token,
                    notification: { title: notification.title, body: notification.body },
                    data: notification.data || {}
                }
            };
            try {
                await axios.post(`https://fcm.googleapis.com/v1/projects/${fcmConfig.project_id}/messages:send`, messagePayload, {
                    headers: { 'Authorization': `Bearer ${googleAccessToken}` }
                });
                return { token: device.token, status: 'sent' };
            } catch (e: any) {
                // Handle invalid tokens (cleanup)
                if (e.response?.status === 404 || e.response?.status === 410) {
                    await pool.query(`DELETE FROM auth.user_devices WHERE token = $1`, [device.token]).catch(() => {});
                }
                return { token: device.token, status: 'error', error: e.message };
            }
        }));

        // 4. Log History
        await systemPool.query(`INSERT INTO system.notification_history (project_slug, user_id, status, provider_response) VALUES ($1, $2, $3, $4)`, 
            [projectSlug, userId, 'completed', JSON.stringify({ results })]);

        return { success: true, results };
    }
}
