import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { Pool, PoolClient, Client } from 'pg';
import { spawn, execSync } from 'child_process';
import { DatabaseService } from './DatabaseService.js';

export class ImportService {
    
    // Limite máximo de tamanho descompactado (5GB)
    private static MAX_UNCOMPRESSED_SIZE = 5 * 1024 * 1024 * 1024;
    // Taxa máxima de compressão permitida (para evitar zip bombs extremos tipo 42.zip)
    private static MAX_COMPRESSION_RATIO = 100;

    /**
     * Valida se um arquivo ZIP é um backup Cascata válido (.caf)
     * e verifica segurança contra Zip Bombs.
     */
    public static async validateBackup(filePath: string): Promise<any> {
        try {
            const zip = new AdmZip(filePath);
            const zipEntries = zip.getEntries();
            
            let totalSize = 0;
            let totalCompressed = 0;

            // 1. Security Check: Zip Bomb Detection & Nested Depth
            for (const entry of zipEntries) {
                totalSize += entry.header.size; // Tamanho original
                totalCompressed += entry.header.compressedSize;
                
                // Check Max Size
                if (totalSize > this.MAX_UNCOMPRESSED_SIZE) {
                    throw new Error("Security Alert: Backup exceeds maximum uncompressed size limit (5GB). Possible Zip Bomb.");
                }
            }

            if (totalCompressed > 0) {
                const ratio = totalSize / totalCompressed;
                if (ratio > this.MAX_COMPRESSION_RATIO) {
                    throw new Error("Security Alert: Compression ratio suspiciously high. Rejected.");
                }
            }

            // 2. Validate Manifest existence
            const manifestEntry = zip.getEntry('manifest.json');
            
            if (!manifestEntry) {
                throw new Error("Arquivo inválido: manifest.json não encontrado na raiz.");
            }

            const manifestContent = manifestEntry.getData().toString('utf8');
            const manifest = JSON.parse(manifestContent);

            if (!manifest.version || !manifest.project) {
                throw new Error("Manifesto corrompido ou formato desconhecido.");
            }

            return manifest;
        } catch (e: any) {
            throw new Error(`Falha na validação do backup: ${e.message}`);
        }
    }

    /**
     * Executa a extração segura do ZIP.
     * Implementa proteção contra 'Zip Slip' (Path Traversal).
     */
    private static extractZipSecurely(zip: AdmZip, outputDir: string) {
        const entries = zip.getEntries();
        const resolvedDest = path.resolve(outputDir);

        for (const entry of entries) {
            // Validate Filename Characters (Basic sanitation)
            if (entry.entryName.includes('..')) {
                throw new Error(`Security Alert: Malicious path detected in zip entry '${entry.entryName}'`);
            }

            // Resolve full path
            const destPath = path.resolve(resolvedDest, entry.entryName);

            // CRITICAL SECURITY CHECK: Zip Slip
            // Ensure the destination path is actually inside the target directory
            if (!destPath.startsWith(resolvedDest)) {
                throw new Error(`Security Alert: Zip Slip attack detected. Entry '${entry.entryName}' tries to write outside target.`);
            }

            if (entry.isDirectory) {
                fs.mkdirSync(destPath, { recursive: true });
            } else {
                // Ensure parent directory exists
                const parentDir = path.dirname(destPath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }
                
                // Write file content securely
                fs.writeFileSync(destPath, entry.getData());
            }
        }
    }

    /**
     * Executa o processo completo de restauração.
     */
    public static async restoreProject(filePath: string, targetSlug: string, systemPool: Pool) {
        // Validação de segurança do slug
        const safeSlug = targetSlug.replace(/[^a-z0-9-_]/gi, '');
        if (safeSlug !== targetSlug) throw new Error("Invalid target slug characters.");

        const tempDir = path.resolve(process.env.TEMP_UPLOAD_ROOT || '../temp_uploads', `restore_${safeSlug}_${Date.now()}`);
        
        try {
            // 1. Extrair ZIP (Securely)
            console.log(`[Import] Extracting CAF to ${tempDir} (Secure Mode)...`);
            const zip = new AdmZip(filePath);
            this.extractZipSecurely(zip, tempDir);

            // 2. Ler Manifesto
            const manifestPath = path.join(tempDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) throw new Error("Manifest not found after extraction.");
            
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            const dbName = `cascata_proj_${safeSlug.replace(/-/g, '_')}`;

            // 3. Provisionar Banco de Dados
            console.log(`[Import] Provisioning Database ${dbName}...`);
            await this.provisionDatabase(dbName, systemPool);

            // 3.1 Inicializar Estrutura Padrão (Auth, Extensões)
            console.log(`[Import] Initializing Base Structure...`);
            await this.initBaseStructure(dbName);

            // 4. Registrar no Sistema
            console.log(`[Import] Registering Project ${targetSlug}...`);
            await this.registerProject(targetSlug, manifest.project.name, dbName, manifest.project, systemPool);

            // 5. Aplicar Schema (DDL) do Backup
            console.log(`[Import] Applying Backup Schema...`);
            const schemaPath = path.join(tempDir, 'schema', 'structure.sql');
            if (fs.existsSync(schemaPath)) {
                await this.executeSqlFile(dbName, schemaPath);
            }

            // 6. Injetar Dados (Bulk Insert)
            console.log(`[Import] Hydrating Data...`);
            const dataDir = path.join(tempDir, 'data');
            if (fs.existsSync(dataDir)) {
                await this.bulkInsertData(dbName, dataDir);
            }

            // 7. Restaurar Storage
            console.log(`[Import] Restoring Storage Files...`);
            const storageSource = path.join(tempDir, 'storage');
            const storageTarget = path.resolve(process.env.STORAGE_ROOT || '../storage', targetSlug);
            
            if (fs.existsSync(storageSource)) {
                // Ensure target doesn't exist or clean it safely
                if (fs.existsSync(storageTarget)) {
                    fs.rmSync(storageTarget, { recursive: true, force: true });
                }
                // Move instead of copy for speed, safe because tempDir is destroyed later
                fs.renameSync(storageSource, storageTarget);
            } else {
                fs.mkdirSync(storageTarget, { recursive: true });
            }

            return { success: true, slug: targetSlug };

        } catch (e: any) {
            console.error('[Import] Fatal Error:', e);
            throw new Error(`Restore Failed: ${e.message}`);
        } finally {
            // Cleanup Temp
            try { 
                if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); 
            } catch (e) { console.error("Failed to clean temp dir", e); }
            
            try { 
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
            } catch(e) { console.error("Failed to delete upload file", e); }
        }
    }

    // --- INTERNAL HELPERS ---

    private static async provisionDatabase(dbName: string, systemPool: Pool) {
        // Drop safely
        await systemPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await systemPool.query(`CREATE DATABASE "${dbName}"`);
    }

    private static async initBaseStructure(dbName: string) {
        const dbUrl = this.getDbUrl(dbName);
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            await DatabaseService.initProjectDb(client);
        } finally {
            await client.end();
        }
    }

    private static getDbUrl(dbName: string): string {
        const user = process.env.DB_USER || 'cascata_admin';
        const pass = process.env.DB_PASS || 'secure_pass';
        const host = process.env.DEFAULT_PROJECT_DB_HOST || 'db';
        return `postgresql://${user}:${pass}@${host}:5432/${dbName}`;
    }

    private static async registerProject(slug: string, name: string, dbName: string, meta: any, systemPool: Pool) {
        await systemPool.query(`
            INSERT INTO system.projects (
                name, slug, db_name, jwt_secret, anon_key, service_key, metadata, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthy')
            ON CONFLICT (slug) DO UPDATE SET
                status = 'healthy',
                jwt_secret = EXCLUDED.jwt_secret,
                anon_key = EXCLUDED.anon_key,
                service_key = EXCLUDED.service_key,
                metadata = EXCLUDED.metadata,
                updated_at = NOW()
        `, [
            name,
            slug,
            dbName,
            meta.jwt_secret,
            meta.anon_key,
            meta.service_key,
            { restored_from: meta.slug, restored_at: new Date(), ...meta.metadata }
        ]);
    }

    private static async executeSqlFile(dbName: string, sqlPath: string) {
        const env = { ...process.env, PGPASSWORD: process.env.DB_PASS };
        const host = process.env.DEFAULT_PROJECT_DB_HOST || 'db';
        const user = process.env.DB_USER || 'postgres';
        
        // Execute via psql shell for robust handling of large files
        try {
            execSync(`psql -h ${host} -U ${user} -d ${dbName} -f "${sqlPath}"`, { env, stdio: 'ignore' });
        } catch (e: any) {
            throw new Error(`Failed to apply SQL schema: ${e.message}`);
        }
    }

    private static async bulkInsertData(dbName: string, dataDir: string) {
        const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));
        const env = { ...process.env, PGPASSWORD: process.env.DB_PASS };
        const host = process.env.DEFAULT_PROJECT_DB_HOST || 'db';
        const user = process.env.DB_USER || 'postgres';

        // 1. Disable Triggers & Constraints via 'replica' role session
        // This is crucial for importing 'auth' schema and handling cyclic FKs during bulk load
        const setReplica = `SET session_replication_role = 'replica';`;

        for (const file of files) {
            let quotedTableName = '';
            const baseName = file.replace('.csv', '');
            
            if (baseName.includes('.')) {
                const parts = baseName.split('.');
                quotedTableName = parts.map(p => `"${p}"`).join('.');
            } else {
                quotedTableName = `"public"."${baseName}"`;
            }
            
            const filePath = path.join(dataDir, file);
            console.log(`[Import] Copying ${quotedTableName}...`);
            
            const copyCmd = `\\COPY ${quotedTableName} FROM STDIN WITH CSV HEADER`;
            
            await new Promise<void>((resolve, reject) => {
                const psql = spawn('psql', [
                    '-h', host,
                    '-U', user,
                    '-d', dbName,
                    '-c', `${setReplica} ${copyCmd}`
                ], { env, stdio: ['pipe', 'ignore', 'pipe'] }); 

                const fileStream = fs.createReadStream(filePath);
                fileStream.on('error', reject);
                fileStream.pipe(psql.stdin);

                psql.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`Copy failed for ${quotedTableName} code ${code}`));
                });
                
                psql.stderr.on('data', (d) => {
                    const msg = d.toString();
                    if (!msg.includes('NOTICE') && !msg.includes('COPY')) {
                        console.warn(`[Import Warning ${quotedTableName}]: ${msg}`);
                    }
                });
            });
        }
    }
}