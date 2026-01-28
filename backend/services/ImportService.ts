
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import { spawn } from 'child_process';
import axios from 'axios';
import FormData from 'form-data';
import { PoolService } from './PoolService.js';
import crypto from 'crypto';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const generateKey = () => crypto.randomBytes(32).toString('hex');

interface ImportOptions {
    mode: 'recovery' | 'template';
    includeData?: boolean;
    nameOverride?: string;
}

export class ImportService {
    
    public static async validateBackup(filePath: string): Promise<any> {
        const zip = new AdmZip(filePath);
        const manifestEntry = zip.getEntry('manifest.json');
        if (!manifestEntry) throw new Error("Snapshot inválido: manifest.json ausente.");
        return JSON.parse(manifestEntry.getData().toString('utf8'));
    }

    public static async restoreProject(filePath: string, targetSlug: string, systemPool: Pool, options: ImportOptions = { mode: 'recovery', includeData: true }) {
        const safeSlug = targetSlug.replace(/[^a-z0-9-_]/gi, '');
        const restoreId = Date.now();
        const tempDir = path.resolve(process.env.TEMP_UPLOAD_ROOT || '../temp_uploads', `restore_${safeSlug}_${restoreId}`);
        const qdrantUrl = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;
        const SYSTEM_JWT_SECRET = process.env.SYSTEM_JWT_SECRET;

        if (!SYSTEM_JWT_SECRET) throw new Error("SYSTEM_JWT_SECRET is missing. Cannot secure project keys.");
        
        const targetDbName = `cascata_db_${safeSlug.replace(/-/g, '_')}`;
        const tempDbName = `cascata_restore_temp_${safeSlug.replace(/-/g, '_')}_${restoreId}`;
        const backupDbName = `cascata_backup_old_${safeSlug.replace(/-/g, '_')}_${restoreId}`;

        try {
            // 0. GARANTIA DE ROLES GLOBAIS
            await systemPool.query(`
                DO $$ 
                BEGIN
                    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
                    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
                    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
                    
                    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cascata_api_role') THEN 
                        CREATE ROLE cascata_api_role NOLOGIN; 
                    END IF;

                    GRANT anon TO cascata_api_role;
                    GRANT authenticated TO cascata_api_role;
                    GRANT service_role TO cascata_api_role;
                END $$;
            `);

            // 1. EXTRAÇÃO SEGURA
            const zip = new AdmZip(filePath);
            const zipEntries = zip.getEntries();
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const resolvedRoot = path.resolve(tempDir);

            zipEntries.forEach((entry) => {
                const targetPath = path.join(tempDir, entry.entryName);
                const resolvedPath = path.resolve(targetPath);
                if (!resolvedPath.startsWith(resolvedRoot)) throw new Error(`Security Violation: Path Traversal`);
                if (entry.isDirectory) {
                    fs.mkdirSync(resolvedPath, { recursive: true });
                } else {
                    const parent = path.dirname(resolvedPath);
                    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
                    fs.writeFileSync(resolvedPath, entry.getData());
                }
            });

            const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'manifest.json'), 'utf-8'));
            const finalProjectName = options.nameOverride || manifest.project.name;

            // 2. ESTRATÉGIA DE CHAVES
            let keys = { jwt_secret: '', anon_key: '', service_key: '' };
            if (options.mode === 'recovery' && fs.existsSync(path.join(tempDir, 'system', 'secrets.json'))) {
                keys = JSON.parse(fs.readFileSync(path.join(tempDir, 'system', 'secrets.json'), 'utf-8'));
            } else {
                keys.jwt_secret = generateKey();
                keys.anon_key = generateKey();
                keys.service_key = generateKey();
            }

            // 3. PROVISIONAMENTO DO BANCO TEMPORÁRIO
            await systemPool.query(`CREATE DATABASE "${tempDbName}"`);
            
            const tempConnString = `postgresql://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_DIRECT_HOST || 'db'}:${process.env.DB_DIRECT_PORT || '5432'}/${tempDbName}`;
            const tempPool = new Pool({ connectionString: tempConnString });
            
            try { await tempPool.query('DROP SCHEMA public CASCADE;'); } catch (e) {} 
            
            // 4. RESTORE DO SCHEMA (DDL)
            const structurePathV2 = path.join(tempDir, 'schema', 'structure.sql');
            const schemaPath = fs.existsSync(structurePathV2) ? structurePathV2 : path.join(tempDir, 'graph', 'structure.sql');

            if (fs.existsSync(schemaPath)) {
                let sqlContent = fs.readFileSync(schemaPath, 'utf-8');
                sqlContent = sqlContent.replace(/^SET transaction_timeout = 0;/gm, '');
                
                sqlContent = sqlContent.replace(/^CREATE SCHEMA public;/gm, '-- public handled manually');
                sqlContent = sqlContent.replace(/^CREATE SCHEMA auth;/gm, '-- auth handled manually');
                sqlContent = sqlContent.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp"/gm, '-- handled manually');
                sqlContent = sqlContent.replace(/CREATE EXTENSION IF NOT EXISTS "pgcrypto"/gm, '-- handled manually');

                const header = [
                    'CREATE SCHEMA IF NOT EXISTS public;',
                    'CREATE SCHEMA IF NOT EXISTS auth;',
                    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;',
                    'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA public;',
                    'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, cascata_api_role;',
                    'GRANT USAGE ON SCHEMA auth TO service_role, cascata_api_role;'
                ].join('\n');
                
                fs.writeFileSync(schemaPath, header + '\n' + sqlContent);
                await this.executeSqlFile(tempDbName, schemaPath);
            }

            // 5. DADOS DE AUTH
            if (options.mode === 'recovery') {
                const authPath = path.join(tempDir, 'system', 'auth_data.sql');
                if (fs.existsSync(authPath)) {
                    let authSql = fs.readFileSync(authPath, 'utf-8');
                    authSql = authSql.replace(/^SET transaction_timeout = 0;/gm, '');
                    fs.writeFileSync(authPath, authSql);
                    await this.executeSqlFile(tempDbName, authPath);
                }
            }

            // 6. DADOS DE NEGÓCIO
            if (options.includeData) {
                const dataDir = path.join(tempDir, 'data');
                if (fs.existsSync(dataDir)) {
                    await this.bulkInsertData(tempDbName, dataDir);
                }
            }

            // 6.1 AJUSTES FINAIS
            await this.resetSequences(tempPool, !options.includeData);
            
            const dbOwner = process.env.DB_USER || 'cascata_admin';
            await tempPool.query(`
                DO $$
                DECLARE r RECORD;
                BEGIN
                    FOR r IN (SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'auth')) LOOP
                        EXECUTE 'ALTER TABLE ' || quote_ident(r.schemaname) || '.' || quote_ident(r.tablename) || ' OWNER TO ' || quote_ident('${dbOwner}');
                    END LOOP;
                    FOR r IN (SELECT sequence_schema, sequence_name FROM information_schema.sequences WHERE sequence_schema IN ('public', 'auth')) LOOP
                        EXECUTE 'ALTER SEQUENCE ' || quote_ident(r.sequence_schema) || '.' || quote_ident(r.sequence_name) || ' OWNER TO ' || quote_ident('${dbOwner}');
                    END LOOP;
                    FOR r IN (SELECT table_schema, table_name FROM information_schema.views WHERE table_schema IN ('public', 'auth')) LOOP
                        EXECUTE 'ALTER VIEW ' || quote_ident(r.table_schema) || '.' || quote_ident(r.table_name) || ' OWNER TO ' || quote_ident('${dbOwner}');
                    END LOOP;
                END $$;
            `);

            await tempPool.query(`
                GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role, cascata_api_role;
                GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role, cascata_api_role;
                GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role, cascata_api_role;
                GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
                GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
                GRANT ALL ON ALL TABLES IN SCHEMA auth TO service_role, cascata_api_role;
                GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO service_role, cascata_api_role;
            `);
            await tempPool.end();

            // 7. ATOMIC SWAP COM LOCK (HARDENED)
            // Impede novas conexões durante a troca para evitar falha no RENAME
            
            const checkTarget = await systemPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [targetDbName]);
            const targetExists = checkTarget.rowCount && checkTarget.rowCount > 0;

            if (targetExists) {
                // Lock Target -> Kill -> Rename to Backup
                await systemPool.query(`ALTER DATABASE "${targetDbName}" WITH ALLOW_CONNECTIONS false`);
                await PoolService.terminate(targetDbName);
                await systemPool.query(`ALTER DATABASE "${targetDbName}" RENAME TO "${backupDbName}"`);
            }

            try {
                // Lock Temp -> Kill -> Rename to Target -> Unlock
                await systemPool.query(`ALTER DATABASE "${tempDbName}" WITH ALLOW_CONNECTIONS false`);
                await PoolService.terminate(tempDbName);
                await systemPool.query(`ALTER DATABASE "${tempDbName}" RENAME TO "${targetDbName}"`);
                await systemPool.query(`ALTER DATABASE "${targetDbName}" WITH ALLOW_CONNECTIONS true`);

                // Cleanup Old
                if (targetExists) {
                    await systemPool.query(`DROP DATABASE IF EXISTS "${backupDbName}"`);
                }

            } catch (renameErr) {
                console.error("[Import] Swap Error. Rolling back...", renameErr);
                if (targetExists) {
                    // Tenta restaurar o antigo se a troca falhou
                    try {
                        await systemPool.query(`ALTER DATABASE "${backupDbName}" RENAME TO "${targetDbName}"`);
                        await systemPool.query(`ALTER DATABASE "${targetDbName}" WITH ALLOW_CONNECTIONS true`);
                    } catch(e) { console.error("FATAL: Rollback failed.", e); }
                }
                throw new Error("Falha na troca de banco de dados. Rollback executado.");
            }

            // 8. UPDATE CONTROL PLANE
            await systemPool.query(`
                INSERT INTO system.projects (name, slug, db_name, jwt_secret, anon_key, service_key, metadata, status) 
                VALUES ($1, $2, $3, pgp_sym_encrypt($4, '${SYSTEM_JWT_SECRET}'), pgp_sym_encrypt($5, '${SYSTEM_JWT_SECRET}'), pgp_sym_encrypt($6, '${SYSTEM_JWT_SECRET}'), $7, 'healthy')
                ON CONFLICT (slug) DO UPDATE 
                SET db_name = EXCLUDED.db_name, name = EXCLUDED.name, jwt_secret = EXCLUDED.jwt_secret,
                    anon_key = EXCLUDED.anon_key, service_key = EXCLUDED.service_key, metadata = EXCLUDED.metadata, updated_at = NOW()
            `, [finalProjectName, targetSlug, targetDbName, keys.jwt_secret, keys.anon_key, keys.service_key, manifest.project.metadata || {}]);

            // 9. VECTORS & STORAGE (Mantidos iguais)
            // ... (Código de vetores e storage omitido para brevidade, permanece igual) ...
            
            const vectorPath = path.join(tempDir, 'vector', 'snapshot.qdrant');
            if (fs.existsSync(vectorPath)) {
                try {
                    await axios.put(`${qdrantUrl}/collections/${safeSlug}`, { vectors: { size: 1536, distance: 'Cosine' } }).catch(() => {});
                    const formData = new FormData();
                    formData.append('snapshot', fs.createReadStream(vectorPath));
                    const uploadRes = await axios.post(`${qdrantUrl}/collections/${safeSlug}/snapshots/upload`, formData, { headers: formData.getHeaders() });
                    const snapshotName = uploadRes.data.result.name;
                    await axios.post(`${qdrantUrl}/collections/${safeSlug}/snapshots/recover`, { location: `${qdrantUrl}/collections/${safeSlug}/snapshots/${snapshotName}` });
                } catch (vErr) { console.warn("Vector restore warning", vErr); }
            }

            const storageSource = path.join(tempDir, 'storage');
            const storageTarget = path.resolve(process.env.STORAGE_ROOT || '../storage', targetSlug);
            if (fs.existsSync(storageSource)) {
                if (fs.existsSync(storageTarget)) await fs.promises.rm(storageTarget, { recursive: true, force: true });
                try { await fs.promises.rename(storageSource, storageTarget); } 
                catch (err: any) {
                    if (err.code === 'EXDEV') {
                        await fs.promises.cp(storageSource, storageTarget, { recursive: true });
                        await fs.promises.rm(storageSource, { recursive: true, force: true });
                    } else throw err;
                }
            }

            return { success: true, slug: targetSlug };

        } catch (e: any) {
            // Garante limpeza se falhar
            try {
                await PoolService.terminate(tempDbName);
                await systemPool.query(`DROP DATABASE IF EXISTS "${tempDbName}"`);
            } catch (c) {}
            throw e;
        } finally {
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    private static async executeSqlFile(dbName: string, sqlPath: string) {
        const env = { ...process.env, PGPASSWORD: process.env.DB_PASS };
        const host = process.env.DB_DIRECT_HOST || 'db';
        const user = process.env.DB_USER || 'cascata_admin';
        return new Promise<void>((resolve, reject) => {
            const child = spawn('psql', [ '-h', host, '-U', user, '-d', dbName, '-f', sqlPath, '-v', 'ON_ERROR_STOP=1' ], { env, stdio: 'inherit' });
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`SQL failed code ${code}`)));
            child.on('error', reject);
        });
    }

    private static async bulkInsertData(dbName: string, dataDir: string) {
        const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv')).sort();
        const env = { ...process.env, PGPASSWORD: process.env.DB_PASS };
        const host = process.env.DB_DIRECT_HOST || 'db';
        const user = process.env.DB_USER || 'cascata_admin';

        for (const file of files) {
            const parts = file.split('.');
            if (parts.length < 3) continue;
            const schema = parts[0];
            const table = parts.slice(1, parts.length - 1).join('.');
            const filePath = path.join(dataDir, file);
            const cmd = `SET session_replication_role = 'replica'; COPY "${schema}"."${table}" FROM STDIN WITH CSV HEADER;`;
            await new Promise<void>((resolve) => {
                const psql = spawn('psql', ['-h', host, '-U', user, '-d', dbName, '-c', cmd], { env });
                fs.createReadStream(filePath).pipe(psql.stdin);
                psql.on('close', () => resolve());
            });
        }
    }

    private static async resetSequences(pool: Pool, shouldRestart: boolean) {
        const query = `
            SELECT S.relname as seq_name, T.relname as table_name, C.attname as col_name
            FROM pg_class AS S
            JOIN pg_depend AS D ON S.oid = D.objid
            JOIN pg_class AS T ON D.refobjid = T.oid
            JOIN pg_attribute AS C ON D.refobjid = C.attrelid AND D.refobjsubid = C.attnum
            JOIN pg_tables AS PT ON T.relname = PT.tablename
            WHERE S.relkind = 'S' AND PT.schemaname = 'public'
        `;
        try {
            const res = await pool.query(query);
            for (const row of res.rows) {
                try {
                    const seq = `"${row.seq_name}"`;
                    if (shouldRestart) await pool.query(`ALTER SEQUENCE ${seq} RESTART WITH 1`);
                    else await pool.query(`SELECT setval('${row.seq_name}', (SELECT COALESCE(MAX("${row.col_name}"), 1) FROM public."${row.table_name}"))`);
                } catch (e) { }
            }
        } catch (e) { console.warn(`[Import] Failed to process sequences:`, e); }
    }
}
