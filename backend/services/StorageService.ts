
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import axios from 'axios';
import FormData from 'form-data';
import { Buffer } from 'buffer';
import jwt from 'jsonwebtoken';
import { spawn } from 'child_process';
import { STORAGE_ROOT } from '../src/config/main.js';

export type StorageProviderType = 'local' | 's3' | 'cloudinary' | 'imagekit' | 'cloudflare_images' | 'gdrive' | 'dropbox' | 'onedrive';

export interface MulterFile {
    path: string;
    originalname: string;
    mimetype: string;
    size: number;
    [key: string]: any;
}

export interface StorageConfig {
    provider: StorageProviderType;
    optimize?: boolean; 
    s3?: {
        bucket: string;
        region: string;
        endpoint?: string;
        accessKeyId: string;
        secretAccessKey: string;
        publicUrlBase?: string;
    };
    cloudinary?: {
        cloudName: string;
        apiKey: string;
        apiSecret: string;
        uploadPreset?: string;
    };
    imagekit?: {
        publicKey: string;
        privateKey: string;
        urlEndpoint: string;
    };
    cloudflare?: {
        accountId: string;
        apiToken: string;
        variant?: string;
    };
    gdrive?: {
        clientEmail: string;
        privateKey: string;
        rootFolderId?: string;
    };
    dropbox?: {
        clientId: string;
        clientSecret: string;
        refreshToken: string;
    };
    onedrive?: {
        clientId: string;
        clientSecret: string;
        refreshToken: string;
    };
}

/**
 * StorageService v3.3 (Fixed GDrive Delete)
 * - Streams Nativos
 * - Presigned URLs
 * - Disk Usage Calculation via OS
 * - Google Drive Path Resolution
 */
export class StorageService {

    /**
     * Calcula o uso físico de disco real usando 'du'.
     * Muito mais rápido e preciso que somar via banco ou recursão de fs.
     */
    public static async getPhysicalDiskUsage(projectSlug: string): Promise<number> {
        const targetDir = path.join(STORAGE_ROOT, projectSlug);
        
        // Se a pasta não existe, uso é 0
        if (!fs.existsSync(targetDir)) return 0;

        return new Promise((resolve, reject) => {
            // 'du -sb' retorna o tamanho em bytes de forma sumarizada
            // -s: summarize, -b: bytes
            const child = spawn('du', ['-sb', targetDir]);
            let output = '';
            let error = '';

            child.stdout.on('data', (data) => { output += data.toString(); });
            child.stderr.on('data', (data) => { error += data.toString(); });

            child.on('close', (code) => {
                if (code !== 0) {
                    console.warn(`[StorageService] 'du' command failed: ${error}. Fallback to 0.`);
                    resolve(0); // Fail safe to avoid blocking uploads if OS command fails
                } else {
                    const bytes = parseInt(output.split(/\s+/)[0]);
                    resolve(isNaN(bytes) ? 0 : bytes);
                }
            });
            
            child.on('error', (err) => {
                console.error(`[StorageService] Failed to spawn 'du':`, err);
                resolve(0);
            });
        });
    }

    // --- PRESIGNED URL GENERATION (DIRECT UPLOAD) ---
    public static async createUploadUrl(
        key: string,
        contentType: string,
        config: StorageConfig
    ): Promise<{ url: string, method: string, headers?: any, strategy: 'direct' | 'proxy' }> {
        
        // S3: Suporte Nativo a Presigned PUT
        if (config.provider === 's3' && config.s3) {
            const s3 = new S3Client({
                region: config.s3.region,
                endpoint: config.s3.endpoint,
                credentials: {
                    accessKeyId: config.s3.accessKeyId,
                    secretAccessKey: config.s3.secretAccessKey
                },
                forcePathStyle: !!config.s3.endpoint 
            });

            const command = new PutObjectCommand({
                Bucket: config.s3.bucket,
                Key: key,
                ContentType: contentType,
                ACL: 'public-read'
            });

            const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
            return { url, method: 'PUT', strategy: 'direct' };
        }

        // Outros providers (GDrive, Dropbox, Local): Retorna Proxy
        return { url: '', method: 'POST', strategy: 'proxy' };
    }

    // --- MAIN UPLOAD METHOD (STREAMING PROXY) ---
    public static async upload(
        file: MulterFile, 
        projectSlug: string, 
        bucketName: string, 
        targetPath: string, 
        config: StorageConfig
    ): Promise<string> {
        // Normaliza caminhos
        const fullKey = path.join(targetPath, file.originalname).replace(/\\/g, '/').replace(/^\//, '');
        const fileStream = fs.createReadStream(file.path);
        
        try {
            switch (config.provider) {
                case 's3':
                    if (!config.s3) throw new Error("S3 Config missing");
                    return await this.uploadS3(fileStream, file, fullKey, config.s3);
                case 'cloudinary':
                    if (!config.cloudinary) throw new Error("Cloudinary Config missing");
                    return await this.uploadCloudinary(fileStream, targetPath, config.cloudinary);
                case 'imagekit':
                    if (!config.imagekit) throw new Error("ImageKit Config missing");
                    return await this.uploadImageKit(fileStream, file, fullKey, config.imagekit);
                case 'cloudflare_images':
                    if (!config.cloudflare) throw new Error("Cloudflare Config missing");
                    return await this.uploadCloudflare(fileStream, config.cloudflare);
                case 'gdrive':
                    if (!config.gdrive) throw new Error("Google Drive Config missing");
                    return await this.uploadGDrive(fileStream, file, targetPath, config.gdrive);
                case 'dropbox':
                    if (!config.dropbox) throw new Error("Dropbox Config missing");
                    return await this.uploadDropbox(fileStream, file, fullKey, config.dropbox);
                case 'onedrive':
                    if (!config.onedrive) throw new Error("OneDrive Config missing");
                    return await this.uploadOneDrive(fileStream, file, fullKey, config.onedrive);
                case 'local':
                default:
                    return ''; // Local handled by controller
            }
        } catch (error: any) {
            console.error(`[StorageService] Upload Failed (${config.provider}):`, error.response?.data || error.message);
            throw new Error(`Upload Failed: ${error.message}`);
        }
    }

    // --- MAIN DELETE METHOD ---
    public static async delete(
        key: string,
        config: StorageConfig
    ): Promise<void> {
        const cleanKey = key.startsWith('/') ? key.substring(1) : key;

        try {
            switch (config.provider) {
                case 's3':
                    if (!config.s3) throw new Error("S3 Config missing");
                    const s3 = new S3Client({
                        region: config.s3.region,
                        endpoint: config.s3.endpoint,
                        credentials: {
                            accessKeyId: config.s3.accessKeyId,
                            secretAccessKey: config.s3.secretAccessKey
                        },
                        forcePathStyle: !!config.s3.endpoint 
                    });
                    await (s3 as any).send(new DeleteObjectCommand({
                        Bucket: config.s3.bucket,
                        Key: cleanKey
                    }));
                    break;

                case 'cloudinary':
                    if (!config.cloudinary) throw new Error("Cloudinary Config missing");
                    const publicId = cleanKey.replace(/\.[^/.]+$/, "");
                    await this.deleteCloudinary(publicId, config.cloudinary);
                    break;
                
                case 'imagekit':
                    if (!config.imagekit) throw new Error("ImageKit Config missing");
                    await this.deleteImageKit(cleanKey, config.imagekit);
                    break;
                
                case 'dropbox':
                    if (!config.dropbox) throw new Error("Dropbox Config missing");
                    await this.deleteDropbox('/' + cleanKey, config.dropbox);
                    break;
                
                case 'onedrive':
                    if (!config.onedrive) throw new Error("OneDrive Config missing");
                    await this.deleteOneDrive(cleanKey, config.onedrive);
                    break;

                case 'gdrive':
                    if (!config.gdrive) throw new Error("Google Drive Config missing");
                    await this.deleteGDrive(cleanKey, config.gdrive);
                    break;
                
                default:
                    throw new Error(`Delete not supported for ${config.provider}`);
            }
        } catch (error: any) {
             console.error(`[StorageService] Delete Failed (${config.provider}):`, error.response?.data || error.message);
             throw new Error(`Delete Failed: ${error.message}`);
        }
    }

    // --- PROVIDER IMPLEMENTATIONS ---

    private static async getGDriveToken(conf: NonNullable<StorageConfig['gdrive']>) {
        const now = Math.floor(Date.now() / 1000);
        const jwtClaim = {
            iss: conf.clientEmail,
            scope: 'https://www.googleapis.com/auth/drive.file',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now
        };
        const signedJwt = jwt.sign(jwtClaim, conf.privateKey, { algorithm: 'RS256' });
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: signedJwt
        });
        return tokenRes.data.access_token;
    }

    private static async uploadS3(stream: fs.ReadStream, file: MulterFile, key: string, conf: NonNullable<StorageConfig['s3']>) {
        const s3 = new S3Client({
            region: conf.region,
            endpoint: conf.endpoint,
            credentials: { accessKeyId: conf.accessKeyId, secretAccessKey: conf.secretAccessKey },
            forcePathStyle: !!conf.endpoint 
        });
        await (s3 as any).send(new PutObjectCommand({
            Bucket: conf.bucket, Key: key, Body: stream, ContentType: file.mimetype, ACL: 'public-read', ContentLength: file.size 
        }));
        if (conf.publicUrlBase) return `${conf.publicUrlBase}/${key}`;
        if (conf.endpoint) return `${conf.endpoint.replace(/\/$/, '')}/${conf.bucket}/${key}`;
        return `https://${conf.bucket}.s3.${conf.region}.amazonaws.com/${key}`;
    }

    private static async uploadCloudinary(stream: fs.ReadStream, folder: string, conf: NonNullable<StorageConfig['cloudinary']>) {
        const formData = new FormData();
        formData.append('file', stream);
        formData.append('api_key', conf.apiKey);
        formData.append('timestamp', Math.floor(Date.now() / 1000).toString());
        if (folder) formData.append('folder', folder);
        if (!conf.uploadPreset) throw new Error("Cloudinary Upload Preset is required.");
        formData.append('upload_preset', conf.uploadPreset);
        const res = await axios.post(`https://api.cloudinary.com/v1_1/${conf.cloudName}/auto/upload`, formData, { headers: formData.getHeaders() });
        return res.data.secure_url;
    }

    private static async deleteCloudinary(publicId: string, conf: NonNullable<StorageConfig['cloudinary']>) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const crypto = await import('crypto');
        const signature = crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${conf.apiSecret}`).digest('hex');
        const formData = new FormData();
        formData.append('public_id', publicId); formData.append('api_key', conf.apiKey); formData.append('timestamp', timestamp); formData.append('signature', signature);
        await axios.post(`https://api.cloudinary.com/v1_1/${conf.cloudName}/image/destroy`, formData, { headers: formData.getHeaders() });
    }

    private static async uploadImageKit(stream: fs.ReadStream, file: MulterFile, key: string, conf: NonNullable<StorageConfig['imagekit']>) {
        const formData = new FormData();
        formData.append('file', stream); formData.append('fileName', file.originalname); formData.append('useUniqueFileName', 'false');
        const folder = path.dirname(key); if (folder && folder !== '.') formData.append('folder', folder);
        const authHeader = `Basic ${Buffer.from(conf.privateKey + ':').toString('base64')}`;
        const res = await axios.post('https://upload.imagekit.io/api/v1/files/upload', formData, { headers: { ...formData.getHeaders(), 'Authorization': authHeader } });
        return res.data.url;
    }

    private static async deleteImageKit(filePath: string, conf: NonNullable<StorageConfig['imagekit']>) {
        const authHeader = `Basic ${Buffer.from(conf.privateKey + ':').toString('base64')}`;
        const searchRes = await axios.get('https://api.imagekit.io/v1/files', { params: { searchQuery: `name = "${path.basename(filePath)}"`, limit: 1 }, headers: { 'Authorization': authHeader } });
        if (searchRes.data && searchRes.data.length > 0) {
            await axios.delete(`https://api.imagekit.io/v1/files/${searchRes.data[0].fileId}`, { headers: { 'Authorization': authHeader } });
        }
    }

    private static async uploadCloudflare(stream: fs.ReadStream, conf: NonNullable<StorageConfig['cloudflare']>) {
        const formData = new FormData(); formData.append('file', stream);
        const res = await axios.post(`https://api.cloudflare.com/client/v4/accounts/${conf.accountId}/images/v1`, formData, { headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${conf.apiToken}` } });
        return res.data.result.variants[0]; 
    }

    private static async uploadGDrive(stream: fs.ReadStream, file: MulterFile, targetPath: string, conf: NonNullable<StorageConfig['gdrive']>) {
        // Updated to use shared helper
        const accessToken = await this.getGDriveToken(conf);
        
        const formData = new FormData();
        formData.append('metadata', JSON.stringify({ name: file.originalname, parents: conf.rootFolderId ? [conf.rootFolderId] : undefined }), { contentType: 'application/json' });
        formData.append('file', stream, { contentType: file.mimetype, knownLength: file.size });
        const uploadRes = await axios.post('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', formData, { headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${accessToken}` } });
        return uploadRes.data.webViewLink;
    }

    private static async deleteGDrive(key: string, conf: NonNullable<StorageConfig['gdrive']>) {
        const token = await this.getGDriveToken(conf);
        const fileName = path.basename(key);
        
        // Search by name and ensure parent folder matches if configured
        let q = `name = '${fileName}' and trashed = false`;
        if (conf.rootFolderId) {
            q += ` and '${conf.rootFolderId}' in parents`;
        }

        const listRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
            headers: { 'Authorization': `Bearer ${token}` },
            params: { q, fields: 'files(id)' }
        });

        const files = listRes.data.files;
        if (files && files.length > 0) {
            // Delete all matching files (usually just one if names are unique)
            for (const file of files) {
                await axios.delete(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            }
        }
    }

    private static async uploadDropbox(stream: fs.ReadStream, file: MulterFile, key: string, conf: NonNullable<StorageConfig['dropbox']>) {
        const tokenRes = await axios.post('https://api.dropbox.com/oauth2/token', null, { params: { grant_type: 'refresh_token', refresh_token: conf.refreshToken, client_id: conf.clientId, client_secret: conf.clientSecret } });
        const uploadRes = await axios.post('https://content.dropboxapi.com/2/files/upload', stream, { headers: { 'Authorization': `Bearer ${tokenRes.data.access_token}`, 'Dropbox-API-Arg': JSON.stringify({ path: '/' + key, mode: 'add', autorename: true, mute: false }), 'Content-Type': 'application/octet-stream', 'Content-Length': file.size }, maxBodyLength: Infinity, maxContentLength: Infinity });
        try {
            const shareRes = await axios.post('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', { path: uploadRes.data.path_display }, { headers: { 'Authorization': `Bearer ${tokenRes.data.access_token}`, 'Content-Type': 'application/json' } });
            return shareRes.data.url.replace('?dl=0', '?dl=1'); 
        } catch(e) { return `https://www.dropbox.com/home/${key}`; }
    }

    private static async deleteDropbox(path: string, conf: NonNullable<StorageConfig['dropbox']>) {
        const tokenRes = await axios.post('https://api.dropbox.com/oauth2/token', null, { params: { grant_type: 'refresh_token', refresh_token: conf.refreshToken, client_id: conf.clientId, client_secret: conf.clientSecret } });
        await axios.post('https://api.dropboxapi.com/2/files/delete_v2', { path }, { headers: { 'Authorization': `Bearer ${tokenRes.data.access_token}`, 'Content-Type': 'application/json' } });
    }

    private static async uploadOneDrive(stream: fs.ReadStream, file: MulterFile, key: string, conf: NonNullable<StorageConfig['onedrive']>) {
        const params = new URLSearchParams(); params.append('client_id', conf.clientId); params.append('client_secret', conf.clientSecret); params.append('refresh_token', conf.refreshToken); params.append('grant_type', 'refresh_token'); params.append('scope', 'Files.ReadWrite.All');
        const tokenRes = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', params);
        const uploadRes = await axios.put(`https://graph.microsoft.com/v1.0/me/drive/root:/${key}:/content`, stream, { headers: { 'Authorization': `Bearer ${tokenRes.data.access_token}`, 'Content-Type': file.mimetype, 'Content-Length': file.size }, maxBodyLength: Infinity, maxContentLength: Infinity });
        return uploadRes.data['@microsoft.graph.downloadUrl'] || uploadRes.data.webUrl;
    }

    private static async deleteOneDrive(key: string, conf: NonNullable<StorageConfig['onedrive']>) {
        const params = new URLSearchParams(); params.append('client_id', conf.clientId); params.append('client_secret', conf.clientSecret); params.append('refresh_token', conf.refreshToken); params.append('grant_type', 'refresh_token'); params.append('scope', 'Files.ReadWrite.All');
        const tokenRes = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', params);
        await axios.delete(`https://graph.microsoft.com/v1.0/me/drive/root:/${key}`, { headers: { 'Authorization': `Bearer ${tokenRes.data.access_token}` } });
    }
}
