
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import { spawn } from 'child_process';
import axios from 'axios';
import FormData from 'form-data';
import { PoolService } from './PoolService.js';
import { RealtimeService } from './RealtimeService.js';
import crypto from 'crypto';
import { SYS_SECRET } from '../src/config/main.js';
import { quoteId } from '../src/utils/index.js';

const generateKey = () => crypto.randomBytes(32).toString('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface MigrationStrategy {
    [tableName: string]: 'overwrite' | 'merge' | 'missing_only' | 'skip';
}

export interface DiffResult {
    schema_diff: {
        added_tables: string[];
        removed_tables: string[];
        modified_tables: { table: string, missing_cols: string[], type_mismatch: string[] }[];
    };
    data_diff: {
        [table: string]: {
            live_count: number;
            backup_count: number;
            conflicts: number; // PK collisions
            strategy_recommendation: 'overwrite' | 'merge' | 'missing_only';
        }
    };
    temp_db_name: string;
}

export class ImportService {
    
    // ... (Keep existing validateBackup, extractZip, findImportRoot helper methods same as before) ...
    public static async validateBackup(filePath: string): Promise<any> {
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        let manifestEntry = zip.getEntry('manifest.json');
        if (!manifestEntry) {
            const nestedManifest = entries.find(e => e.entryName.match(/^[^/]+\/manifest\.json$/));
            if (nestedManifest) manifestEntry = nestedManifest;
        }
        if (!manifestEntry) throw new Error("Snapshot inválido: manifest.json ausente.");
        return JSON.parse(manifestEntry.getData().toString('utf8'));
    }

    private static async extractZip(filePath: string, destDir: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const unzip = spawn('unzip', ['-o', filePath, '-d', destDir]);
            let errorLog = '';
            unzip.stderr.on('data', (d) => errorLog += d.toString());
            unzip.on('error', (err) => {
                try { const zip = new AdmZip(filePath); zip.extractAllTo(destDir, true); resolve(); } catch (e) { reject(e); }
            });
            unzip.on('close', (code) => {
                if (code === 0) resolve();
                else { try { const zip = new AdmZip(filePath); zip.extractAllTo(destDir, true); resolve(); } catch (e) { reject(new Error(`Unzip failed: ${errorLog}`)); } }
            });
        });
    }

    private static findImportRoot(baseDir: string): string {
        if (fs.existsSync(path.join(baseDir, 'manifest.json'))) return baseDir;
        const items = fs.readdirSync(baseDir, { withFileTypes: true });
        const subDirs = items.filter(d => d.isDirectory());
        if (subDirs.length === 1) {
            const subPath = path.join(baseDir, subDirs[0].name);
            if (fs.existsSync(path.join(subPath, 'manifest.json'))) return subPath;
        }
        return baseDir;
    }

    /**
     * PHASE 1: STAGE & ANALYZE
     * Restores backup to a TEMP DB and compares it with LIVE DB.
     * Returns a Diff Report for the user to make decisions.
     */
    public static async stageAndAnalyze(filePath: string, targetSlug: string, systemPool: Pool): Promise<DiffResult> {
        const restoreId = Date.now();
        const safeSlug = targetSlug.replace(/[^a-z0-9-_]/gi, '');
        const tempDir = path.resolve(process.env.TEMP_UPLOAD_ROOT || '../temp_uploads', `stage_${safeSlug}_${restoreId}`);
        const tempDbName = `cascata_stage_${safeSlug.replace(/-/g, '_')}_${restoreId}`;
        
        // 1. Get Live DB Info
        const projRes = await systemPool.query('SELECT db_name FROM system.projects WHERE slug = $1', [targetSlug]);
        if (projRes.rows.length === 0) throw new Error("Project not found");
        const liveDbName = projRes.rows[0].db_name;

        try {
            // 2. Extract & Restore to Temp DB (Structure + Data)
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            await this.extractZip(filePath, tempDir);
            const importRoot = this.findImportRoot(tempDir);
            
            // Create Temp DB
            await systemPool.query(`CREATE DATABASE "${tempDbName}"`);
            
            // Restore Schema & Data to Temp
            // Note: We use the existing restore logic but point to tempDbName
            await this.hydrateTempDb(tempDbName, importRoot);

            // 3. ANALYSIS ENGINE
            const diff = await this.generateDiff(liveDbName, tempDbName);
            
            return { ...diff, temp_db_name: tempDbName };

        } catch (e) {
            // Cleanup on failure
            await systemPool.query(`DROP DATABASE IF EXISTS "${tempDbName}"`);
            throw e;
        } finally {
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    /**
     * PHASE 2: EXECUTE SMART MIGRATION
     * Moves data from Temp to Live based on user strategy per table.
     */
    public static async executeMigration(
        targetSlug: string, 
        tempDbName: string, 
        strategies: MigrationStrategy,
        systemPool: Pool,
        preserveKeys: boolean
    ) {
        const projRes = await systemPool.query('SELECT db_name, jwt_secret, anon_key, service_key FROM system.projects WHERE slug = $1', [targetSlug]);
        const liveDbName = projRes.rows[0].db_name;
        
        // Backup Name for Panic Button (Time Travel)
        const backupDbName = `cascata_rollback_${targetSlug.replace(/-/g, '_')}_${Date.now()}`;

        const host = process.env.DB_DIRECT_HOST || 'db';
        const user = process.env.DB_USER || 'cascata_admin';
        const pass = process.env.DB_PASS;

        // Connections
        const livePool = new Pool({ connectionString: `postgresql://${user}:${pass}@${host}:5432/${liveDbName}` });
        const tempPool = new Pool({ connectionString: `postgresql://${user}:${pass}@${host}:5432/${tempDbName}` });

        try {
            // 1. Create Safety Snapshot of LIVE (Clone DB)
            // Fastest way: CREATE DATABASE ... TEMPLATE ... requires no connections. 
            // So we kick connections first.
            await PoolService.terminate(liveDbName);
            await systemPool.query(`CREATE DATABASE "${backupDbName}" WITH TEMPLATE "${liveDbName}"`);

            // 2. Apply Schema Changes (If any) - Naive approach: We trust the backup structure for 'overwrite'
            // For 'merge', we assume schema compatibility or use what's in live.
            
            // 3. DATA MIGRATION
            
            const isFullOverwrite = Object.values(strategies).every(s => s === 'overwrite');

            if (isFullOverwrite) {
                // Classic Swap
                await this.performDatabaseSwap(systemPool, liveDbName, tempDbName, backupDbName); // backupDbName is redundant here as we already cloned, but logic handles rename
                
                // If preserveKeys, restore them to system table
                if (preserveKeys) {
                    // Keys are in system.projects, they are not touched by DB swap.
                    // But if backup contained secrets.json and we wanted to overwrite, we would update system.projects.
                    // preserveKeys = TRUE means DO NOT update system.projects keys.
                }
            } else {
                // GRANULAR MIGRATION (Hard Mode)
                
                for (const [table, strategy] of Object.entries(strategies)) {
                    if (strategy === 'skip') continue;

                    console.log(`[Migration] Applying ${strategy} on ${table}`);
                    
                    // Disable triggers/constraints for speed
                    await livePool.query(`ALTER TABLE public.${quoteId(table)} DISABLE TRIGGER ALL`);

                    if (strategy === 'overwrite') {
                        await livePool.query(`TRUNCATE TABLE public.${quoteId(table)} CASCADE`);
                    }

                    // Pipe Data: Temp -> Live
                    // Uses streaming to avoid RAM issues
                    await this.pipeTableData(tempDbName, liveDbName, table, strategy);

                    await livePool.query(`ALTER TABLE public.${quoteId(table)} ENABLE TRIGGER ALL`);
                }
                
                // Drop Temp DB after granular merge
                await systemPool.query(`DROP DATABASE IF EXISTS "${tempDbName}"`);
            }

            // 4. Update Asset Storage (Files) if full overwrite
            // If granular, we can't easily merge files without logic. We assume storage overwrite if DB overwrite.
            
            return { success: true, rollback_id: backupDbName };

        } catch (e) {
            console.error("Migration Failed", e);
            throw e;
        } finally {
            await livePool.end();
            await tempPool.end();
        }
    }

    /**
     * PHASE 3: PANIC BUTTON (UNDO)
     */
    public static async revertRestore(targetSlug: string, backupDbName: string, systemPool: Pool) {
        const projRes = await systemPool.query('SELECT db_name FROM system.projects WHERE slug = $1', [targetSlug]);
        const currentLiveDb = projRes.rows[0].db_name;
        const failedDbName = `${currentLiveDb}_failed_${Date.now()}`;

        // 1. Kill connections
        await PoolService.terminate(currentLiveDb);

        // 2. Rotate
        // Rename Live -> Failed
        await systemPool.query(`ALTER DATABASE "${currentLiveDb}" RENAME TO "${failedDbName}"`);
        // Rename Backup -> Live
        await systemPool.query(`ALTER DATABASE "${backupDbName}" RENAME TO "${currentLiveDb}"`);

        // 3. Drop Failed (Optional, maybe keep for debug)
        // await systemPool.query(`DROP DATABASE "${failedDbName}"`);
        
        return { success: true };
    }

    /**
     * Restore Project (Full Overwrite)
     * Orchestrates the restore process without the UI diff step.
     */
    public static async restoreProject(
        filePath: string, 
        targetSlug: string, 
        systemPool: Pool, 
        options: { mode: string, includeData: boolean, nameOverride?: string }
    ) {
        const restoreId = Date.now();
        const safeSlug = targetSlug.replace(/[^a-z0-9-_]/gi, '');
        const tempDir = path.resolve(process.env.TEMP_UPLOAD_ROOT || '../temp_uploads', `restore_${safeSlug}_${restoreId}`);
        const tempDbName = `cascata_restore_${safeSlug.replace(/-/g, '_')}_${restoreId}`;

        try {
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            await this.extractZip(filePath, tempDir);
            const importRoot = this.findImportRoot(tempDir);

            // Create Temp DB
            await systemPool.query(`CREATE DATABASE "${tempDbName}"`);

            // Hydrate
            await this.hydrateTempDb(tempDbName, importRoot);

            // Determine Strategy: Overwrite All
            const host = process.env.DB_DIRECT_HOST || 'db';
            const user = process.env.DB_USER || 'cascata_admin';
            const pass = process.env.DB_PASS;
            const tempPool = new Pool({ connectionString: `postgresql://${user}:${pass}@${host}:5432/${tempDbName}` });
            
            const tablesRes = await tempPool.query(`
                SELECT table_name FROM information_schema.tables 
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            `);
            await tempPool.end();

            const strategies: MigrationStrategy = {};
            tablesRes.rows.forEach((r: any) => {
                strategies[r.table_name] = 'overwrite';
            });

            // Execute Migration
            const result = await this.executeMigration(targetSlug, tempDbName, strategies, systemPool, false);
            
            return result;

        } catch (e) {
            // Ensure temp DB is dropped on error if executeMigration didn't reach that point
            try { await systemPool.query(`DROP DATABASE IF EXISTS "${tempDbName}"`); } catch(dbe) {}
            throw e;
        } finally {
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    // --- HELPER ENGINES ---

    private static async generateDiff(liveDb: string, tempDb: string): Promise<DiffResult> {
        const host = process.env.DB_DIRECT_HOST || 'db';
        const user = process.env.DB_USER || 'cascata_admin';
        const pass = process.env.DB_PASS;

        const livePool = new Pool({ connectionString: `postgresql://${user}:${pass}@${host}:5432/${liveDb}` });
        const tempPool = new Pool({ connectionString: `postgresql://${user}:${pass}@${host}:5432/${tempDb}` });

        try {
            // Get Schemas
            const getTableSchema = async (pool: Pool) => {
                const res = await pool.query(`
                    SELECT table_name, column_name, data_type 
                    FROM information_schema.columns 
                    WHERE table_schema = 'public'
                `);
                const tables: Record<string, any[]> = {};
                res.rows.forEach(r => {
                    if (!tables[r.table_name]) tables[r.table_name] = [];
                    tables[r.table_name].push({ name: r.column_name, type: r.data_type });
                });
                return tables;
            };

            const liveSchema = await getTableSchema(livePool);
            const tempSchema = await getTableSchema(tempPool);

            const added = Object.keys(tempSchema).filter(t => !liveSchema[t]);
            const removed = Object.keys(liveSchema).filter(t => !tempSchema[t]);
            const modified = [];
            const dataDiff: any = {};

            const commonTables = Object.keys(tempSchema).filter(t => liveSchema[t]);

            for (const table of commonTables) {
                // Schema Diff
                const liveCols = liveSchema[table];
                const tempCols = tempSchema[table];
                const missingCols = liveCols.filter(lc => !tempCols.find(tc => tc.name === lc.name)).map(c => c.name);
                // Simple type check
                const typeMismatch = []; // Implement deep check if needed
                
                if (missingCols.length > 0) {
                    modified.push({ table, missing_cols: missingCols, type_mismatch: [] });
                }

                // Data Diff (Heavy Calc)
                const liveCount = parseInt((await livePool.query(`SELECT count(*) FROM "${table}"`)).rows[0].count);
                const backupCount = parseInt((await tempPool.query(`SELECT count(*) FROM "${table}"`)).rows[0].count);
                
                // Conflict Check (ID collision)
                let conflicts = 0;
                try {
                     const pkRes = await tempPool.query(`
                        SELECT a.attname
                        FROM   pg_index i
                        JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                        WHERE  i.indrelid = '"${table}"'::regclass AND i.indisprimary;
                     `);
                     if (pkRes.rows.length > 0) {
                         conflicts = -1; // "Unknown / Calc Required" indicator
                     }
                } catch (e) {}

                dataDiff[table] = {
                    live_count: liveCount,
                    backup_count: backupCount,
                    conflicts: conflicts,
                    strategy_recommendation: liveCount === 0 ? 'overwrite' : 'merge'
                };
            }

            return {
                schema_diff: { added_tables: added, removed_tables: removed, modified_tables: modified },
                data_diff: dataDiff,
                temp_db_name: tempDb // Pass through
            };

        } finally {
            await livePool.end();
            await tempPool.end();
        }
    }

    // Helper to pipe data between DBs using streams (Robust for Granular Migration)
    private static async pipeTableData(sourceDb: string, targetDb: string, table: string, strategy: string) {
        const env = { ...process.env };
        const host = process.env.DB_DIRECT_HOST || 'db';
        const user = process.env.DB_USER || 'cascata_admin';

        // 1. Dump Data from Source (CSV)
        const dumpProc = spawn('psql', [
            '-h', host, '-U', user, '-d', sourceDb, 
            '-c', `COPY (SELECT * FROM "${table}") TO STDOUT WITH CSV`
        ], { env });

        // 2. Prepare Import Command based on Strategy
        let importSql = '';
        if (strategy === 'overwrite') {
            importSql = `COPY "${table}" FROM STDIN WITH CSV`;
        } else {
            // Simplified Approach for this example: 
            // Fallback unsafe copy (will fail on conflict if PK exists and duplicates are present)
            // Real implementation requires dynamic temp tables and ON CONFLICT logic.
            importSql = `COPY "${table}" FROM STDIN WITH CSV`; 
        }

        const importProc = spawn('psql', [
            '-h', host, '-U', user, '-d', targetDb,
            '-c', importSql
        ], { env });

        dumpProc.stdout.pipe(importProc.stdin);

        return new Promise<void>((resolve, reject) => {
            importProc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Data pipe failed for ${table}`));
            });
            importProc.stdin.on('error', () => {}); // Handle EPIPE
        });
    }

    private static async hydrateTempDb(dbName: string, importRoot: string) {
        const tempConnString = `postgresql://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_DIRECT_HOST || 'db'}:${process.env.DB_DIRECT_PORT || '5432'}/${dbName}`;
        const tempPool = new Pool({ connectionString: tempConnString });

        // Structure
        const schemaPath = path.join(importRoot, 'schema', 'structure.sql');
        if (fs.existsSync(schemaPath)) {
            let sqlContent = fs.readFileSync(schemaPath, 'utf-8');
            // Minimal Sanitization
            sqlContent = sqlContent
                .replace(/^ALTER OWNER TO.*;$/gm, '--')
                .replace(/^SET transaction_timeout =.*;$/gm, '--'); 
            await this.executeSqlFile(dbName, schemaPath);
        }

        // Data
        const dataDir = path.join(importRoot, 'data');
        if (fs.existsSync(dataDir)) {
            await this.bulkInsertData(dbName, dataDir);
        }
        
        // Sequences fix
        await this.resetSequences(tempPool, false);
        await tempPool.end();
    }

    private static async resetSequences(pool: Pool, log: boolean = false) {
        const client = await pool.connect();
        try {
            const res = await client.query(`
                SELECT 'SELECT setval(' || quote_literal(quote_ident(S.relname)) || ', COALESCE(MAX(' ||quote_ident(C.attname)|| '), 1) ) FROM ' || quote_ident(T.relname) || ';' as fix_sql
                FROM pg_class AS S, pg_depend AS D, pg_class AS T, pg_attribute AS C
                WHERE S.relkind = 'S' AND S.oid = D.objid AND D.refobjid = T.oid
                AND D.refobjid = C.attrelid AND D.refobjsubid = C.attnum
                AND T.relname NOT LIKE '_deleted_%'
            `);
            for (const row of res.rows) {
                if (log) console.log(`[Import] Fixing sequence: ${row.fix_sql}`);
                try {
                    await client.query(row.fix_sql);
                } catch(e) {
                    // Ignore errors on specific sequence fixes
                }
            }
        } finally {
            client.release();
        }
    }
    
    private static async performDatabaseSwap(systemPool: Pool, targetDb: string, tempDb: string, backupDb: string) {
        await this.killAndRename(systemPool, targetDb, backupDb);
        try {
            await this.killAndRename(systemPool, tempDb, targetDb);
        } catch (err) {
            await this.killAndRename(systemPool, backupDb, targetDb);
            throw err;
        }
    }
    
    private static async killAndRename(pool: Pool, from: string, to: string) {
        await pool.query(`UPDATE pg_database SET datallowconn = 'false' WHERE datname = '${from}'`);
        await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from}'`);
        await pool.query(`ALTER DATABASE "${from}" RENAME TO "${to}"`);
        await pool.query(`UPDATE pg_database SET datallowconn = 'true' WHERE datname = '${to}'`);
    }

    private static async executeSqlFile(dbName: string, sqlPath: string) {
         const env = { ...process.env, PGPASSWORD: process.env.DB_PASS };
         const child = spawn('psql', ['-h', 'db', '-U', process.env.DB_USER!, '-d', dbName, '-f', sqlPath], { env });
         return new Promise<void>((resolve, reject) => child.on('close', c => c===0?resolve():reject(new Error('SQL Error'))));
    }

    private static async bulkInsertData(dbName: string, dataDir: string) {
         const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));
         for (const f of files) {
             const [schema, table] = f.replace('.csv','').split('.');
             const cmd = `COPY "${schema}"."${table}" FROM STDIN WITH CSV HEADER`;
             const child = spawn('psql', ['-h', 'db', '-U', process.env.DB_USER!, '-d', dbName, '-c', cmd], { env: { ...process.env, PGPASSWORD: process.env.DB_PASS } });
             fs.createReadStream(path.join(dataDir, f)).pipe(child.stdin);
             await new Promise<void>(r => child.on('close', () => r()));
         }
    }
}
