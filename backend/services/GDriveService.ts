
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Buffer } from 'buffer';

interface ServiceAccountConfig {
    client_email: string;
    private_key: string;
    root_folder_id?: string;
}

/**
 * GDriveService v4.0 (Enterprise Zero-Disk Edition)
 * Implementa Upload Resumable com Chunking em Memória.
 * Elimina a necessidade de arquivos temporários em disco.
 */
export class GDriveService {
    
    // GDrive exige chunks múltiplos de 256KB. Usaremos 5MB (256 * 20) para eficiência de rede.
    private static readonly CHUNK_SIZE = 5 * 1024 * 1024; 

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
                throw new Error("Credenciais Inválidas: Verifique a Chave Privada e o Email.");
            }
            throw e;
        }
    }

    public static async validateConfig(config: ServiceAccountConfig): Promise<{ valid: boolean, message: string }> {
        try {
            const token = await this.getGoogleToken(config);
            
            if (!config.root_folder_id) {
                return { valid: true, message: "Conexão Google API estabelecida (Raiz)." };
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
                return { valid: true, message: "Permissão de ESCRITA confirmada." };
            }
            
            return { valid: false, message: "Falha ao testar escrita." };

        } catch (e: any) {
            if (e.response?.status === 404) return { valid: false, message: "Pasta não encontrada (404)." };
            if (e.response?.status === 403) return { valid: false, message: "Permissão Negada (403)." };
            return { valid: false, message: `Erro: ${e.message}` };
        }
    }

    /**
     * Upload via Stream com Chunking em Memória.
     * Não toca no disco. Usa buffers rotativos para enviar chunks de 5MB.
     */
    public static async uploadStream(
        stream: Readable, 
        fileName: string, 
        mimeType: string, 
        config: ServiceAccountConfig
    ): Promise<{ id: string, webViewLink: string, size: string }> {
        
        const token = await this.getGoogleToken(config);

        // 1. Iniciar Sessão de Upload Resumable (Sem tamanho definido inicialmente)
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
                    'Content-Type': 'application/json'
                }
            }
        );

        const uploadUrl = initRes.headers.location;
        if (!uploadUrl) throw new Error("GDrive falhou ao iniciar sessão de upload.");

        // 2. Processamento de Stream em Chunks
        let buffer = Buffer.alloc(0);
        let offset = 0;
        let finalResponse: any = null;

        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);

            // Enquanto tivermos mais que o tamanho do chunk, envia
            while (buffer.length >= this.CHUNK_SIZE) {
                const part = buffer.slice(0, this.CHUNK_SIZE);
                buffer = buffer.slice(this.CHUNK_SIZE);
                
                await this.uploadChunk(uploadUrl, part, offset, offset + this.CHUNK_SIZE - 1, '*');
                offset += this.CHUNK_SIZE;
            }
        }

        // 3. Enviar o restante (Finalização)
        const remaining = buffer.length;
        const totalSize = offset + remaining;
        
        // Se o arquivo for vazio ou sobrar algo
        if (totalSize === 0) {
            // Caso especial arquivo vazio
             finalResponse = await axios.put(uploadUrl, '', {
                headers: { 'Content-Range': `bytes */0` }
            });
        } else {
            // Último chunk define o tamanho total
            finalResponse = await this.uploadChunk(
                uploadUrl, 
                buffer, 
                offset, 
                offset + remaining - 1, 
                totalSize.toString()
            );
        }

        if (!finalResponse || !finalResponse.data || !finalResponse.data.id) {
             throw new Error("Upload finalizado mas sem resposta de ID do Google.");
        }

        return {
            id: finalResponse.data.id,
            webViewLink: finalResponse.data.webViewLink,
            size: finalResponse.data.size || totalSize.toString()
        };
    }

    private static async uploadChunk(url: string, data: Buffer, start: number, end: number, total: string) {
        // Retry logic simples para estabilidade de rede
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await axios.put(url, data, {
                    headers: {
                        'Content-Range': `bytes ${start}-${end}/${total}`,
                        'Content-Type': 'application/octet-stream' // Importante para chunks binários
                    },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                });
                
                // 308 Resume Incomplete é esperado para chunks intermediários
                if (res.status === 308 || res.status === 200 || res.status === 201) {
                    return res;
                }
            } catch (e: any) {
                // Se for o último chunk e der sucesso, axios pode lançar erro se não esperar JSON
                if (e.response && (e.response.status === 200 || e.response.status === 201)) return e.response;
                
                if (attempt === 3) throw new Error(`Falha no upload do chunk bytes ${start}-${end}: ${e.message}`);
                await new Promise(r => setTimeout(r, 1000 * attempt)); // Backoff
            }
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
        try {
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
                    await this.deleteFile(file.id, config).catch(() => {});
                }
            }
        } catch (e) { console.warn("[GDrive] Retention Prune Warning:", e); }
    }
}
