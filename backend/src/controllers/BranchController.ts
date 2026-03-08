
import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { DatabaseService } from '../../services/DatabaseService.js';
import { PoolService } from '../../services/PoolService.js';
import { Pool } from 'pg';
import { quoteId } from '../utils/index.js';

export class BranchController {

    static async getStatus(req: CascataRequest, res: any, next: any) {
        try {
            const draftDbName = `${req.project.db_name}_draft`;
            const exists = await DatabaseService.dbExists(draftDbName);
            
            res.json({
                has_draft: exists,
                project_slug: req.project.slug,
                live_db: req.project.db_name,
                draft_db: draftDbName,
                sync_active: req.project.metadata?.draft_sync_active || false
            });
        } catch (e: any) { next(e); }
    }

    // --- SNAPSHOTS & ROLLBACK ---

    static async listSnapshots(req: CascataRequest, res: any, next: any) {
        try {
            const liveDb = req.project.db_name;
            const snapshots = await DatabaseService.listDatabaseSnapshots(liveDb);
            res.json(snapshots);
        } catch(e: any) { next(e); }
    }

    static async rollback(req: CascataRequest, res: any, next: any) {
        try {
            const { snapshot_name, mode } = req.body;
            if (!snapshot_name) return res.status(400).json({ error: "Snapshot name required" });

            const liveDb = req.project.db_name;
            const result = await DatabaseService.restoreSnapshot(liveDb, snapshot_name, mode || 'hard');
            
            // Log the operation
            await systemPool.query(
                `INSERT INTO system.async_operations (project_slug, type, status, metadata) 
                 VALUES ($1, 'rollback', 'completed', $2)`,
                [req.project.slug, JSON.stringify({ mode, from: snapshot_name, quarantine: result.quarantineDb })]
            );

            res.json({ success: true, message: "Rollback successful.", quarantine: result.quarantineDb });
        } catch(e: any) { 
            console.error("Rollback failed:", e);
            res.status(500).json({ error: e.message }); 
        }
    }

    // ---------------------------

    static async createDraft(req: CascataRequest, res: any, next: any) {
        try {
            const { mode, percent } = req.body; 
            const liveDb = req.project.db_name;
            const draftDb = `${liveDb}_draft`;

            console.log(`[Branch] Creating/Rebasing Draft for ${req.project.slug}. Data: ${percent}%`);

            if (await DatabaseService.dbExists(draftDb)) {
                await DatabaseService.dropDatabase(draftDb);
            }

            await DatabaseService.cloneDatabase(liveDb, draftDb);
            await DatabaseService.fixPermissions(draftDb);

            if (mode === 'schema' || percent === 0) {
                await DatabaseService.truncatePublicTables(draftDb);
            } else if (typeof percent === 'number' && percent < 100 && percent > 0) {
                await DatabaseService.pruneDatabase(draftDb, percent);
            }

            await PoolService.reload(draftDb);
            
            res.json({ 
                success: true, 
                message: `Draft environment synchronized with Live (${percent !== undefined ? percent : (mode === 'schema' ? 0 : 100)}% Data).` 
            });
        } catch (e: any) { next(e); }
    }
    
    static async toggleSync(req: CascataRequest, res: any, next: any) {
        try {
            const { active } = req.body;
            await systemPool.query(
                `UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{draft_sync_active}', $1::jsonb) WHERE slug = $2`,
                [JSON.stringify(active), req.project.slug]
            );
            res.json({ success: true, active });
        } catch(e: any) { next(e); }
    }

    static async syncFromLive(req: CascataRequest, res: any, next: any) {
        try {
            const liveDb = req.project.db_name;
            const draftDb = `${liveDb}_draft`;

            if (!(await DatabaseService.dbExists(draftDb))) {
                return res.status(404).json({ error: "Draft environment not active." });
            }

            const { table } = req.body; 
            const result = await DatabaseService.smartDataSync(liveDb, draftDb, table);

            res.json({ 
                success: true, 
                message: "Data synced from Live to Draft successfully.", 
                details: result 
            });
        } catch (e: any) { next(e); }
    }
    
    static async deleteDraft(req: CascataRequest, res: any, next: any) {
        try {
            const draftDb = `${req.project.db_name}_draft`;
            if (!(await DatabaseService.dbExists(draftDb))) {
                return res.status(404).json({ error: "No draft to delete." });
            }
            await DatabaseService.dropDatabase(draftDb);
            await PoolService.close(draftDb);
            
            await systemPool.query(
                `UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{draft_sync_active}', 'false'::jsonb) WHERE slug = $1`,
                [req.project.slug]
            );

            res.json({ success: true, message: "Draft environment discarded." });
        } catch (e: any) { next(e); }
    }

    static async deployDraft(req: CascataRequest, res: any, next: any) {
        try {
            const { strategy, sql, dry_run, data_strategy, data_plan } = req.body; 
            const liveDb = req.project.db_name;
            const draftDb = `${liveDb}_draft`;
            const backupDb = `${liveDb}_backup_${Date.now()}`;

            if (!(await DatabaseService.dbExists(draftDb))) {
                return res.status(404).json({ error: "Draft environment not found." });
            }
            
            // --- SECURITY FOUNDATION: INSTANT SNAPSHOT ---
            if (!dry_run) {
                try {
                    await DatabaseService.createSnapshot(liveDb, backupDb);
                    
                    await systemPool.query(
                        `INSERT INTO system.async_operations (project_slug, type, status, metadata) 
                         VALUES ($1, 'snapshot', 'completed', $2)`,
                        [req.project.slug, JSON.stringify({ backup_db: backupDb, reason: 'pre_deploy' })]
                    );
                    
                    console.log(`[Deploy] Safety snapshot created: ${backupDb}`);
                } catch (e: any) {
                    console.error('[Deploy] FATAL: Failed to create safety snapshot. Aborting deploy.', e);
                    return res.status(500).json({ error: "Safety Snapshot Failed. Deploy aborted to protect data." });
                }
            }
            // ----------------------------------------------

            if (strategy === 'merge') {
                if (!sql || typeof sql !== 'string') {
                    return res.status(400).json({ error: "SQL migration script is required for merge strategy." });
                }

                const livePool = PoolService.get(liveDb, { useDirect: true });
                const client = await livePool.connect();
                
                try {
                    await client.query('BEGIN');
                    await client.query("SET LOCAL statement_timeout = '60s'");
                    
                    if (sql.trim()) {
                        const cleanSql = sql
                            .replace(/BEGIN\s*;?/gi, '')
                            .replace(/COMMIT\s*;?/gi, '')
                            .replace(/ROLLBACK\s*;?/gi, '');
                            
                        await client.query(cleanSql);
                    }
                    
                    if ((data_strategy && data_strategy !== 'none') || data_plan) {
                         if (!dry_run) {
                             console.log(`[Deploy] Executing atomic granular data merge.`);
                             await DatabaseService.mergeData(
                                 draftDb, 
                                 liveDb, 
                                 undefined, 
                                 data_strategy, // May be undefined, handled in service
                                 data_plan,
                                 client 
                             );
                         }
                    }

                    await client.query(`
                        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
                        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
                    `);

                    if (dry_run) {
                        await client.query('ROLLBACK'); 
                        return res.json({ success: true, message: "Dry run successful. SQL and Data Plan are valid." });
                    } else {
                        await client.query('COMMIT');
                    }
                } catch (e: any) {
                    await client.query('ROLLBACK');
                    console.error('[Deploy] Transaction failed:', e);
                    return res.status(400).json({ error: `Migration Failed: ${e.message}`, detail: e.detail || e.hint });
                } finally {
                    client.release();
                }

                if (!dry_run) {
                    await DatabaseService.dropDatabase(draftDb);
                    await PoolService.close(draftDb);
                    await PoolService.reload(liveDb); 
                    
                    await systemPool.query(
                        `UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{draft_sync_active}', 'false'::jsonb) WHERE slug = $1`,
                        [req.project.slug]
                    );
                }

                res.json({ success: true, message: "Schema merged successfully. Draft environment closed." });

            } else {
                if (dry_run) return res.json({ success: true, message: "Dry run not supported for Swap strategy." });
                
                const swapBackupName = `${liveDb}_swap_temp_${Date.now()}`;
                
                await DatabaseService.performDatabaseSwap(liveDb, draftDb, swapBackupName);
                await PoolService.reload(liveDb);
                await PoolService.reload(draftDb);
                
                await DatabaseService.dropDatabase(swapBackupName);
                
                await systemPool.query(
                    `UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{draft_sync_active}', 'false'::jsonb) WHERE slug = $1`,
                    [req.project.slug]
                );
                
                res.json({ success: true, message: "Environment swapped successfully.", backup_id: backupDb });
            }

        } catch (e: any) { next(e); }
    }

    static async getDiff(req: CascataRequest, res: any, next: any) {
        try {
            const liveDb = req.project.db_name;
            const draftDb = `${liveDb}_draft`;

            if (!(await DatabaseService.dbExists(draftDb))) {
                return res.status(404).json({ error: "Draft environment not active." });
            }

            const livePool = PoolService.get(liveDb, { useDirect: true });
            const draftPool = PoolService.get(draftDb, { useDirect: true });

            const getIntrospection = async (pool: Pool) => {
                const tables = await pool.query(`
                    SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
                    FROM information_schema.columns 
                    WHERE table_schema = 'public'
                `);
                
                const tableProps = await pool.query(`
                    SELECT relname, relrowsecurity 
                    FROM pg_class 
                    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace 
                    WHERE nspname = 'public' AND relkind = 'r'
                `);
                
                const indexes = await pool.query(`
                    SELECT schemaname, tablename, indexname, indexdef
                    FROM pg_indexes
                    WHERE schemaname = 'public' AND indexname NOT LIKE '%_pkey'
                `);

                const policies = await pool.query(`
                    SELECT policyname, tablename, cmd, roles, qual, with_check
                    FROM pg_policies
                    WHERE schemaname = 'public'
                `);

                const constraints = await pool.query(`
                    SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name, tc.constraint_name
                    FROM information_schema.table_constraints AS tc 
                    JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
                    JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
                    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
                `);

                return {
                    cols: tables.rows,
                    props: tableProps.rows,
                    idxs: indexes.rows,
                    pols: policies.rows,
                    fks: constraints.rows
                };
            };

            const [liveMeta, draftMeta] = await Promise.all([getIntrospection(livePool), getIntrospection(draftPool)]);

            const dataAnalysis = await DatabaseService.generateDataDiff(draftDb, liveDb);

            const liveTables = new Set(liveMeta.cols.map(c => c.table_name));
            const draftTables = new Set(draftMeta.cols.map(c => c.table_name));

            const addedTables = [...draftTables].filter(x => !liveTables.has(x));
            const commonTables = [...draftTables].filter(x => liveTables.has(x));

            const changes: any = {
                added_tables: addedTables,
                removed_tables: [], 
                modified_tables: [],
                indexes: [],
                policies: [],
                data_summary: dataAnalysis 
            };

            let sql = `-- Cascata Intelligent Migration v3.5\n-- Generated at ${new Date().toISOString()}\n\n`;
            
            // 1. CREATE NEW TABLES
            for (const table of addedTables) {
                const cols = draftMeta.cols.filter(c => c.table_name === table);
                const colDefs = cols.map(c => {
                    let def = `"${c.column_name}" ${c.data_type}`;
                    if (c.character_maximum_length) def += `(${c.character_maximum_length})`;
                    if (c.is_nullable === 'NO') def += ' NOT NULL';
                    if (c.column_default) def += ` DEFAULT ${c.column_default}`;
                    return def;
                }).join(',\n  ');
                
                sql += `-- [NEW TABLE] ${table}\n`;
                sql += `CREATE TABLE public."${table}" (\n  ${colDefs}\n);\n`;
                
                const draftProp = draftMeta.props.find(p => p.relname === table);
                if (draftProp?.relrowsecurity) {
                    sql += `ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;\n`;
                }
                
                sql += `CREATE TRIGGER ${table}_changes AFTER INSERT OR UPDATE OR DELETE ON public."${table}" FOR EACH ROW EXECUTE FUNCTION public.notify_changes();\n\n`;
            }

            // 2. MODIFY TABLES
            for (const table of commonTables) {
                const liveCols = liveMeta.cols.filter(c => c.table_name === table);
                const draftCols = draftMeta.cols.filter(c => c.table_name === table);
                
                const liveProp = liveMeta.props.find(p => p.relname === table);
                const draftProp = draftMeta.props.find(p => p.relname === table);

                if (liveProp && draftProp && liveProp.relrowsecurity !== draftProp.relrowsecurity) {
                    sql += `-- [SECURITY] RLS Status Change for ${table}\n`;
                    sql += `ALTER TABLE public."${table}" ${draftProp.relrowsecurity ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY;\n`;
                }

                let addedCols = draftCols.filter(dc => !liveCols.find(lc => lc.column_name === dc.column_name));
                let removedCols = liveCols.filter(lc => !draftCols.find(dc => dc.column_name === lc.column_name));

                // HEURISTIC: RENAME DETECTION
                if (addedCols.length === 1 && removedCols.length === 1) {
                    const added = addedCols[0];
                    const removed = removedCols[0];

                    if (added.data_type === removed.data_type) {
                        sql += `-- [SMART RENAME] Detected rename from ${removed.column_name} to ${added.column_name}\n`;
                        sql += `ALTER TABLE public."${table}" RENAME COLUMN "${removed.column_name}" TO "${added.column_name}";\n`;
                        
                        if (added.is_nullable !== removed.is_nullable) {
                             const setNull = added.is_nullable === 'YES' ? 'DROP NOT NULL' : 'SET NOT NULL';
                             sql += `ALTER TABLE public."${table}" ALTER COLUMN "${added.column_name}" ${setNull};\n`;
                        }

                        addedCols = [];
                        removedCols = [];
                        
                        changes.modified_tables.push({ 
                            table, 
                            renamed_cols: [{ from: removed.column_name, to: added.column_name }] 
                        });
                    }
                }
                
                if (addedCols.length > 0) {
                    sql += `-- [ADD COLUMNS] ${table}\n`;
                    for (const col of addedCols) {
                        let def = `ADD COLUMN "${col.column_name}" ${col.data_type}`;
                        if (col.character_maximum_length) def += `(${col.character_maximum_length})`;
                        
                        if (col.is_nullable === 'NO' && col.column_default) {
                            def += ` DEFAULT ${col.column_default} NOT NULL`;
                        } else if (col.is_nullable === 'NO') {
                            def += ` -- WARN: Created as NULLABLE. Populate data then set NOT NULL manually.`;
                        }
                        sql += `ALTER TABLE public."${table}" ${def};\n`;
                    }
                    if (!changes.modified_tables.find((m: any) => m.table === table)) {
                        changes.modified_tables.push({ table, added_cols: addedCols.map(c => c.column_name) });
                    }
                }

                for (const col of removedCols) {
                    sql += `-- [SAFEGUARD] Suggested Drop: ALTER TABLE public."${table}" DROP COLUMN "${col.column_name}";\n`;
                }
            }

            // 3. SYNC INDEXES
            const liveIdxMap = new Set(liveMeta.idxs.map(i => i.indexdef));
            const newIndexes = draftMeta.idxs.filter(i => !liveIdxMap.has(i.indexdef));
            
            if (newIndexes.length > 0) {
                sql += `-- [NEW INDEXES]\n`;
                for (const idx of newIndexes) {
                    changes.indexes.push(idx.indexname);
                    sql += `${idx.indexdef};\n`;
                }
                sql += `\n`;
            }

            // 4. SYNC RLS POLICIES
            sql += `-- [SECURITY POLICIES]\n`;
            for (const table of [...commonTables, ...addedTables]) {
                const livePols = liveMeta.pols.filter(p => p.tablename === table);
                const draftPols = draftMeta.pols.filter(p => p.tablename === table);

                for (const pol of draftPols) {
                    const existing = livePols.find(p => p.policyname === pol.policyname);
                    const isSame = existing && 
                        existing.cmd === pol.cmd && 
                        existing.qual === pol.qual && 
                        existing.with_check === pol.with_check &&
                        JSON.stringify(existing.roles) === JSON.stringify(pol.roles);

                    if (!existing || !isSame) {
                        changes.policies.push({ table, policy: pol.policyname, type: existing ? 'UPDATE' : 'CREATE' });
                        sql += `DROP POLICY IF EXISTS "${pol.policyname}" ON public."${table}";\n`;
                        sql += `CREATE POLICY "${pol.policyname}" ON public."${table}" FOR ${pol.cmd} TO ${pol.roles.join(',')} USING (${pol.qual}) ${pol.with_check ? `WITH CHECK (${pol.with_check})` : ''};\n`;
                    }
                }
            }

            res.json({
                diff: {
                    ...changes,
                    generated_sql: sql
                }
            });

        } catch (e: any) { next(e); }
    }
}
