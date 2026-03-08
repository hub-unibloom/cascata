
import archiver from 'archiver';
import { Pool, Client } from 'pg';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { Readable, PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import { URL } from 'url';
import { GDriveService } from './GDriveService.js';
import { S3BackupService } from './S3BackupService.js';
import { systemPool, SYS_SECRET, TEMP_UPLOAD_ROOT } from '../src/config/main.js';

export interface ProjectMetadata {
    id: string;
    name: string;
    slug: string;
    db_name: string;
    jwt_secret: string;
    anon_key: string;
    service_key: string;
    custom_domain?: string;
    metadata?: any;
}

interface TableDefinition {
    schema: string;
    name: string;
}

export class BackupService {
    
    /**
     * Generate backup to a temporary file on disk (Safety against OOM).
     */
    public static async generateBackupToFile(project: ProjectMetadata): Promise<string> {
        const tempFilePath = path.join(TEMP_UPLOAD_ROOT, `backup_${project.slug}_${Date.now()}.zip`);
        const output = fs.createWriteStream(tempFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        const qdrantUrl = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;

        archive.pipe(output);

        try {
            const connectionString = this.resolveConnectionString(project);

            // 1. MANIFEST
            const manifest = {
                version: '2.0',
                engine: 'Cascata-Architect-v7',
                exported_at: new Date().toISOString(),
                type: 'full_snapshot',
                project: {
                    name: project.name,
                    slug: project.slug,
                    db_name: project.db_name,
                    custom_domain: project.custom_domain,
                    metadata: project.metadata
                }
            };
            archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

            // 2. SECRETS
            const secrets = {
                jwt_secret: project.jwt_secret,
                anon_key: project.anon_key,
                service_key: project.service_key
            };
            archive.append(JSON.stringify(secrets, null, 2), { name: 'system/secrets.json' });

            // 3. VECTORS (Snapshot)
            try {
                // Trigger snapshot creation on Qdrant
                const snapRes = await axios.post(`${qdrantUrl}/collections/${project.slug}/snapshots`);
                if (snapRes.data?.result?.name) {
                    const snapName = snapRes.data.result.name;
                    const snapDownloadUrl = `${qdrantUrl}/collections/${project.slug}/snapshots/${snapName}`;
                    const snapResponse = await axios.get(snapDownloadUrl, { responseType: 'stream' });
                    archive.append(snapResponse.data, { name: `vector/snapshot.qdrant` });
                }
            } catch (vErr: any) {
                console.warn(`[Backup] Vector snapshot skipped (Collection might not exist): ${vErr.message}`);
            }

            // 4. SCHEMA (Structure)
            // Uses hardened pg_dump flags to ensure portability
            const schemaStream = await this.getSchemaDumpStream(connectionString);
            archive.append(schemaStream, { name: 'schema/structure.sql' });

            // 5. AUTH (System Data)
            const authDataStream = await this.getDataDumpStream(connectionString, ['auth']);
            archive.append(authDataStream, { name: 'system/auth_data.sql' });

            // 6. BUSINESS DATA (Public Schema)
            const tables = await this.listTables(connectionString);
            for (const table of tables) {
                if (table.schema === 'public') {
                    // Use COPY TO STDOUT for maximum speed and type safety in CSV
                    const tableStream = await this.getTableCsvStream(connectionString, table.schema, table.name);
                    archive.append(tableStream, { name: `data/${table.schema}.${table.name}.csv` });
                }
            }

            // 7. STORAGE (Physical Files)
            const projectStoragePath = path.resolve(process.env.STORAGE_ROOT || '../storage', project.slug);
            if (fs.existsSync(projectStoragePath)) {
                archive.directory(projectStoragePath, 'storage');
            }

            await archive.finalize();

            // Wait for file stream to close
            await new Promise<void>((resolve, reject) => {
                output.on('close', () => resolve());
                output.on('error', reject);
            });

            return tempFilePath;

        } catch (e: any) {
            console.error('[BackupService] Critical Failure:', e);
            archive.abort();
            output.destroy(); 
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); 
            throw e;
        }
    }

    public static async streamExport(project: ProjectMetadata, res: any) {
        let tempFile: string | null = null;
        try {
            tempFile = await this.generateBackupToFile(project);
            res.attachment(`${project.slug}_${new Date().toISOString().split('T')[0]}.caf`);
            
            const fileStream = fs.createReadStream(tempFile);
            fileStream.pipe(res);
            
            fileStream.on('close', () => {
                if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            });

        } catch (e: any) {
            if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            if (!res.headersSent) res.status(500).send({ error: 'Snapshot generation failed.' });
        }
    }

    /**
     * Specialized Streamer for System Logs (Observability)
     * Uses PSQL COPY TO STDOUT to avoid disk IO on the database container.
     */
    public static async getLogExportStream(projectSlug: string): Promise<Readable> {
        const host = process.env.DB_DIRECT_HOST || 'db';
        const port = process.env.DB_DIRECT_PORT || '5432';
        const user = process.env.DB_USER || 'cascata_admin';
        const pass = process.env.DB_PASS || 'secure_pass';
        const db = process.env.DB_NAME || 'cascata_system';

        const safeSlug = projectSlug.replace(/[^a-z0-9-_]/gi, '');
        const query = `COPY (SELECT * FROM system.api_logs WHERE project_slug = '${safeSlug}' ORDER BY created_at DESC) TO STDOUT WITH CSV HEADER`;

        const env = { ...process.env, PGPASSWORD: pass };
        const args = ['-h', host, '-p', port, '-U', user, '-d', db, '-c', query];

        const child = spawn('psql', args, { env });

        child.stderr.on('data', (d) => {
            const errText = d.toString();
            if (!errText.includes('NOTICE')) { 
                console.error('[BackupService] Log Export Error:', errText);
            }
        });

        child.on('error', (err) => {
            console.error('[BackupService] Failed to spawn psql:', err);
            throw err;
        });

        return child.stdout;
    }

    public static async executePolicyJob(policyId: string) {
        console.log(`[BackupJob] Starting policy ${policyId}`);
        
        const policyRes = await systemPool.query(
            `SELECT p.id, p.project_slug, p.name, p.provider, p.schedule_cron, p.retention_count,
             CASE 
                WHEN p.config ? 'encrypted_data' THEN pgp_sym_decrypt(decode(p.config->>'encrypted_data', 'base64'), $2)
                ELSE p.config::text
             END as config_str,
             pr.name as proj_name, pr.db_name, pr.slug, 
             pgp_sym_decrypt(pr.jwt_secret::bytea, $2) as jwt_secret,
             pgp_sym_decrypt(pr.anon_key::bytea, $2) as anon_key,
             pgp_sym_decrypt(pr.service_key::bytea, $2) as service_key,
             pr.metadata, pr.custom_domain
             FROM system.backup_policies p
             JOIN system.projects pr ON pr.slug = p.project_slug
             WHERE p.id = $1`,
            [policyId, SYS_SECRET]
        );

        if (policyRes.rows.length === 0) throw new Error("Policy not found");
        const policy = policyRes.rows[0];
        const config = JSON.parse(policy.config_str);
        
        const project: ProjectMetadata = {
            id: policy.project_slug,
            name: policy.proj_name,
            slug: policy.slug,
            db_name: policy.db_name,
            jwt_secret: policy.jwt_secret,
            anon_key: policy.anon_key,
            service_key: policy.service_key,
            custom_domain: policy.custom_domain,
            metadata: policy.metadata
        };

        const historyRes = await systemPool.query(
            `INSERT INTO system.backup_history (policy_id, project_slug, status) VALUES ($1, $2, 'running') RETURNING id`,
            [policyId, policy.slug]
        );
        const historyId = historyRes.rows[0].id;

        let tempFile: string | null = null;

        try {
            // Generate to DISK first to calculate size and avoid OOM
            tempFile = await this.generateBackupToFile(project);
            const fileName = `${policy.slug}_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.caf`;

            const fileStream = fs.createReadStream(tempFile);

            let result;
            const provider = policy.provider || 'gdrive';

            if (provider === 'gdrive') {
                result = await GDriveService.uploadStream(fileStream, fileName, 'application/zip', config);
                await GDriveService.enforceRetention(config, policy.retention_count, policy.slug);
            } 
            else if (['s3', 'b2', 'r2', 'wasabi', 'aws'].includes(provider)) {
                result = await S3BackupService.uploadStream(fileStream, fileName, 'application/zip', config);
                await S3BackupService.enforceRetention(config, policy.retention_count, policy.slug);
            } 
            else {
                throw new Error(`Provider ${provider} not supported`);
            }

            const stats = fs.statSync(tempFile);
            const finalSize = stats.size;

            await systemPool.query(
                `UPDATE system.backup_history 
                 SET status = 'completed', finished_at = NOW(), file_size = $1, file_name = $2, external_id = $3
                 WHERE id = $4`,
                [finalSize, fileName, result.id, historyId]
            );
            
            await systemPool.query(
                `UPDATE system.backup_policies SET last_run_at = NOW(), last_status = 'success' WHERE id = $1`,
                [policyId]
            );

        } catch (e: any) {
            console.error(`[BackupJob] Failed: ${e.message}`);
            await systemPool.query(
                `UPDATE system.backup_history SET status = 'failed', finished_at = NOW(), logs = $1 WHERE id = $2`,
                [e.message, historyId]
            );
            await systemPool.query(
                `UPDATE system.backup_policies SET last_status = 'failed' WHERE id = $1`,
                [policyId]
            );
            throw e;
        } finally {
            if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
    }

    private static resolveConnectionString(project: ProjectMetadata): string {
        if (project.metadata?.external_db_url) return project.metadata.external_db_url;
        const host = process.env.DB_DIRECT_HOST || 'db';
        const port = process.env.DB_DIRECT_PORT || '5432';
        const user = process.env.DB_USER || 'cascata_admin';
        const pass = process.env.DB_PASS || 'secure_pass';
        return `postgresql://${user}:${pass}@${host}:${port}/${project.db_name}`;
    }

    private static async listTables(connectionString: string): Promise<TableDefinition[]> {
        const isExternal = !connectionString.includes(process.env.DB_DIRECT_HOST || 'db');
        const client = new Client({ connectionString, ssl: isExternal ? { rejectUnauthorized: false } : false });
        try {
            await client.connect();
            const res = await client.query(`
                SELECT table_schema, table_name 
                FROM information_schema.tables 
                WHERE table_schema IN ('public', 'auth') 
                AND table_type = 'BASE TABLE'
                AND table_name NOT LIKE '_deleted_%'
            `);
            return res.rows.map(r => ({ schema: r.table_schema, name: r.table_name }));
        } finally { 
            await client.end().catch(() => {}); 
        }
    }

    private static async getSchemaDumpStream(connectionString: string): Promise<Readable> {
        const url = new URL(connectionString);
        const args = [
            '--host', url.hostname,
            '--port', url.port,
            '--username', url.username,
            '--dbname', url.pathname.slice(1),
            '--schema-only', 
            '--no-owner', 
            '--no-privileges',
            '--no-tablespaces',
            '--no-unlogged-table-data',
            '-n', 'public',
            '-n', 'auth'
        ];
        const child = spawn('pg_dump', args, { env: { ...process.env, PGPASSWORD: url.password } });
        if (!child.stdout) throw new Error("pg_dump stdout null");
        return child.stdout;
    }

    private static async getDataDumpStream(connectionString: string, schemas: string[]): Promise<Readable> {
        const url = new URL(connectionString);
        const args = [
            '--host', url.hostname,
            '--port', url.port,
            '--username', url.username,
            '--dbname', url.pathname.slice(1),
            '--data-only',
            '--no-owner',
            '--no-privileges',
            '--column-inserts', 
            '--disable-triggers', 
            ...schemas.flatMap(s => ['-n', s])
        ];
        const child = spawn('pg_dump', args, { env: { ...process.env, PGPASSWORD: url.password } });
        if (!child.stdout) throw new Error("pg_dump data stdout null");
        return child.stdout;
    }

    private static async getTableCsvStream(connectionString: string, schema: string, tableName: string): Promise<Readable> {
        const url = new URL(connectionString);
        const query = `COPY (SELECT * FROM "${schema}"."${tableName}") TO STDOUT WITH CSV HEADER`;
        const args = ['-h', url.hostname, '-p', url.port, '-U', url.username, '-d', url.pathname.slice(1), '-c', query];
        const child = spawn('psql', args, { env: { ...process.env, PGPASSWORD: url.password } });
        if (!child.stdout) throw new Error("psql stdout null");
        return child.stdout;
    }
}
