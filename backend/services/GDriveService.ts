
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { TEMP_UPLOAD_ROOT } from '../src/config/main.js';

interface ServiceAccountConfig {
    client_email: string;
    private_key: string;
    root_folder_id?: string;
}

export class GDriveService {
    
    /**
     * Gera Token JWT para Service Account do Google.
     */
    private static getAccessToken(config: ServiceAccountConfig): string {
        const now = Math.floor(Date.now() / 1000);
        const claim = {
            iss: config.client_email,
            scope: "https://www.googleapis.com/auth/drive.file",
            aud: "https://oauth2.googleapis.com/token",
            exp: now + 3600,
            iat: now
        };
        return jwt.sign(claim, config.private_key, { algorithm: 'RS256' });
    }

    private static async getGoogleToken(config: ServiceAccountConfig): Promise<string> {
        const assertion = this.getAccessToken(config);
        try {
            const res = await axios.post('https://oauth2.googleapis.com/token', {
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion
            });
            return res.data.access_token;
        } catch (e: any) {
            if (e.response && e.response.data && e.response.data.error === 'invalid_grant') {
                throw new Error("Credenciais Inválidas: Verifique se a Chave Privada e o Email do Cliente estão corretos no JSON.");
            }
            throw e;
        }
    }

    public static async validateConfig(config: ServiceAccountConfig): Promise<{ valid: boolean, message: string }> {
        try {
            const token = await this.getGoogleToken(config);
            
            if (!config.root_folder_id) {
                return { valid: true, message: "Conexão com Google API estabelecida (Raiz)." };
            }

            const metadata = {
                name: '.cascata_probe',
                parents: [config.root_folder_id],
                mimeType: 'text/plain'
            };

            const createRes = await axios.post(
                'https://www.googleapis.com/drive/v3/files',
                metadata,
                { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );

            if (createRes.data.id) {
                await axios.delete(`https://www.googleapis.com/drive/v3/files/${createRes.data.id}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                return { valid: true, message: "Permissão de ESCRITA confirmada na pasta." };
            }
            
            return { valid: false, message: "Falha desconhecida ao testar escrita." };

        } catch (e: any) {
            if (e.response?.status === 404) return { valid: false, message: "Pasta não encontrada (404)." };
            if (e.response?.status === 403) return { valid: false, message: "Permissão Negada (403)." };
            return { valid: false, message: `Erro: ${e.message}` };
        }
    }

    public static async uploadStream(
        stream: Readable, 
        fileName: string, 
        mimeType: string, 
        config: ServiceAccountConfig
    ): Promise<{ id: string, webViewLink: string, size: string }> {
        
        const token = await this.getGoogleToken(config);
        
        // GDrive precisa do tamanho exato para upload resumable.
        // Bufferizamos em disco temporário para calcular.
        const tempPath = path.join(TEMP_UPLOAD_ROOT, `backup_buffer_${Date.now()}_${Math.random().toString(36).substr(2)}.tmp`);
        const writeStream = fs.createWriteStream(tempPath);

        await pipeline(stream, writeStream);

        const stats = fs.statSync(tempPath);
        const fileSize = stats.size;
        const fileStream = fs.createReadStream(tempPath);

        try {
            const metadata = {
                name: fileName,
                mimeType: mimeType,
                parents: config.root_folder_id ? [config.root_folder_id] : undefined
            };

            const initRes = await axios.post(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
                metadata,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'X-Upload-Content-Length': fileSize.toString()
                    }
                }
            );

            const uploadUrl = initRes.headers.location;
            if (!uploadUrl) throw new Error("GDrive Resumable Upload failed to initialize.");

            const uploadRes = await axios.put(uploadUrl, fileStream, {
                headers: {
                    'Content-Type': mimeType,
                    'Content-Length': fileSize.toString()
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });

            return {
                id: uploadRes.data.id,
                webViewLink: uploadRes.data.webViewLink,
                size: uploadRes.data.size
            };

        } finally {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
    }

    public static async deleteFile(fileId: string, config: ServiceAccountConfig) {
        const token = await this.getGoogleToken(config);
        await axios.delete(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
    }

    public static async downloadToPath(fileId: string, destPath: string, config: ServiceAccountConfig): Promise<void> {
        const token = await this.getGoogleToken(config);
        
        const res = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${token}` },
            responseType: 'stream'
        });

        await pipeline(res.data, fs.createWriteStream(destPath));
    }

    public static async enforceRetention(config: ServiceAccountConfig, retentionCount: number, filePrefix: string) {
        if (!config.root_folder_id || retentionCount <= 0) return;
        const token = await this.getGoogleToken(config);
        const q = `'${config.root_folder_id}' in parents and name contains '${filePrefix}' and trashed = false`;
        
        const listRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
            headers: { 'Authorization': `Bearer ${token}` },
            params: { q, orderBy: 'createdTime desc', fields: 'files(id, name, createdTime)' }
        });

        const files = listRes.data.files || [];
        
        if (files.length > retentionCount) {
            const toDelete = files.slice(retentionCount);
            for (const file of toDelete) {
                try { await this.deleteFile(file.id, config); } catch (e) { console.warn(`[GDrive] Prune error:`, e); }
            }
        }
    }
}
