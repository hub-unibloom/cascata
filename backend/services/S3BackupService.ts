
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';
import fs from 'fs';
import { pipeline } from 'stream/promises';

export interface S3Config {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export class S3BackupService {

    private static getClient(config: S3Config): S3Client {
        return new S3Client({
            region: config.region,
            endpoint: config.endpoint, // Vital para B2, R2, Wasabi, MinIO
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey
            },
            forcePathStyle: true // Garante compatibilidade com providers não-AWS
        });
    }

    /**
     * Valida a conexão listando objetos.
     */
    public static async validateConfig(config: S3Config): Promise<{ valid: boolean, message: string }> {
        try {
            const s3 = this.getClient(config);
            // Tenta listar 1 objeto para verificar Auth e Permissões de Leitura
            // Cast to any to avoid TS error about 'send' property
            await (s3 as any).send(new ListObjectsV2Command({
                Bucket: config.bucket,
                MaxKeys: 1
            }));
            
            return { valid: true, message: "Conexão S3 estabelecida e Bucket acessível." };
        } catch (e: any) {
            console.error('[S3 Verify]', e.message);
            if (e.name === 'NoSuchBucket') return { valid: false, message: "O Bucket especificado não existe." };
            if (e.name === 'AccessDenied') return { valid: false, message: "Acesso negado. Verifique suas chaves e permissões do Bucket." };
            return { valid: false, message: `Erro de conexão: ${e.message}` };
        }
    }

    /**
     * Realiza Upload Multipart via Stream (Evita estouro de memória).
     */
    public static async uploadStream(
        stream: Readable, 
        fileName: string, 
        mimeType: string, 
        config: S3Config
    ): Promise<{ id: string, size: number }> {
        const s3 = this.getClient(config);
        
        try {
            const parallelUploads3 = new Upload({
                client: s3,
                params: {
                    Bucket: config.bucket,
                    Key: fileName,
                    Body: stream,
                    ContentType: mimeType
                },
                // Otimização para arquivos grandes (>50MB)
                queueSize: 4,
                partSize: 1024 * 1024 * 5 // 5MB chunks
            });

            const result = await parallelUploads3.done();
            
            return {
                id: result.Key || fileName,
                size: 0 // Tamanho real deve ser atualizado pelo chamador se necessário, ou via metadata
            };
        } catch (e: any) {
            console.error('[S3 Upload] Failed:', e);
            throw new Error(`S3 Upload Failed: ${e.message}`);
        }
    }

    /**
     * Gera URL assinada para download direto.
     */
    public static async getSignedDownloadUrl(key: string, config: S3Config): Promise<string> {
        const s3 = this.getClient(config);
        const command = new GetObjectCommand({
            Bucket: config.bucket,
            Key: key
        });
        return await getSignedUrl(s3, command, { expiresIn: 3600 }); // Link válido por 1 hora
    }

    /**
     * Baixa o arquivo para um caminho local via Stream (Usado no Restore).
     */
    public static async downloadToPath(key: string, destPath: string, config: S3Config): Promise<void> {
        const s3 = this.getClient(config);
        const command = new GetObjectCommand({
            Bucket: config.bucket,
            Key: key
        });
        
        // Cast to any to avoid TS error about 'send' property
        const response = await (s3 as any).send(command);
        
        if (!response.Body) throw new Error("Empty body from S3 response");
        
        // Pipeline garante que o stream seja fechado corretamente em caso de erro
        await pipeline(response.Body as Readable, fs.createWriteStream(destPath));
    }

    /**
     * Política de Retenção: Remove backups antigos.
     */
    public static async enforceRetention(config: S3Config, retentionCount: number, filePrefix: string) {
        if (retentionCount <= 0) return;
        const s3 = this.getClient(config);

        try {
            const listCommand = new ListObjectsV2Command({
                Bucket: config.bucket,
                Prefix: filePrefix // Filtra apenas backups deste projeto
            });

            // Cast to any to avoid TS error about 'send' property
            const data = await (s3 as any).send(listCommand);
            const files = data.Contents || [];

            // Ordena descendente por data (Mais novos primeiro)
            files.sort((a: any, b: any) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

            if (files.length > retentionCount) {
                const toDelete = files.slice(retentionCount);
                console.log(`[S3] Pruning ${toDelete.length} old backups...`);

                const deleteCommand = new DeleteObjectsCommand({
                    Bucket: config.bucket,
                    Delete: {
                        Objects: toDelete.map((f: any) => ({ Key: f.Key }))
                    }
                });

                // Cast to any to avoid TS error about 'send' property
                await (s3 as any).send(deleteCommand);
            }
        } catch (e: any) {
            console.warn(`[S3] Retention policy warning: ${e.message}`);
        }
    }
}
