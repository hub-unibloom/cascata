import { Request, Response, NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { DatabaseService } from '../../services/DatabaseService.js';
import { PoolService } from '../../services/PoolService.js';
import { Pool } from 'pg';
import { quoteId } from '../utils/index.js';

export class BranchController {

    static async getStatus(req: Request, res: Response, next: NextFunction) {
        const r = (req as unknown) as CascataRequest;
        try {
            const draftDbName = `${r.project.db_name}_draft`;
            const exists = await DatabaseService.dbExists(draftDbName);

            res.json({
                has_draft: exists,
                project_slug: r.project.slug,
                live_db: r.project.db_name,
                draft_db: draftDbName,
                sync_active: r.project.metadata?.draft_sync_active || false
            });
        } catch (e: unknown) { next(e); }
    }

    // --- SNAPSHOTS & ROLLBACK ---

    static async listSnapshots(req: Request, res: Response, next: NextFunction) {
        const r = req as CascataRequest;
        try {
            const liveDb = r.project.db_name;
            const snapshots = await DatabaseService.listDatabaseSnapshots(liveDb);
            res.json(snapshots);
        } catch (e: unknown) { next(e); }
    }

    static async rollback(req: Request, res: Response, next: NextFunction) {
        const r = (req as unknown) as CascataRequest;
        try {
            const { snapshot_name, mode } = req.body as { snapshot_name: string; mode?: 'hard' | 'smart' };
            if (!snapshot_name) return res.status(400).json({ error: "Snapshot name required" });

            const liveDb = r.project.db_name;
            const result = await DatabaseService.restoreSnapshot(liveDb, snapshot_name, mode || 'hard');

            // Log the operation
            await systemPool.query(
                `INSERT INTO system.async_operations (project_slug, type, status, metadata) 
                 VALUES ($1, 'rollback', 'completed', $2)`,
                [r.project.slug, JSON.stringify({ mode, from: snapshot_name, quarantine: result.quarantineDb })]
            );

            res.json({ success: true, message: "Rollback successful.", quarantine: result.quarantineDb });
        } catch (e: unknown) {
            console.error("Rollback failed:", e);
            res.status(500).json({ error: (e as Error).message });
        }
    }

    // ---------------------------

    static async createDraft(req: Request, res: Response, next: NextFunction) {
        const r = (req as unknown) as CascataRequest;
        try {
            const { mode, percent } = req.body as { mode?: 'schema' | 'hybrid'; percent?: number };
            const liveDb = r.project.db_name;
            const draftDb = `${liveDb}_draft`;

            console.log(`[Branch] Creating/Rebasing Draft for ${r.project.slug}. Data: ${percent}%`);

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
        } catch (e: unknown) { next(e); }
    }

    static async toggleSync(req: Request, res: Response, next: NextFunction) {
        const r = (req as unknown) as CascataRequest;
        try {
            const { active } = req.body as { active: boolean };
            await systemPool.query(
                `UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{draft_sync_active}', $1::jsonb) WHERE slug = $2`,
                [JSON.stringify(active), r.project.slug]
            );
            res.json({ success: true, active });
        } catch (e: unknown) { next(e); }
    }

    static async syncFromLive(req: CascataRequest, res: any, next: any) {
        try {
            const liveDb = r.project.db_name;
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
            const draftDb = `${r.project.db_name}_draft`;
            if (!(await DatabaseService.dbExists(draftDb))) {
                return res.status(404).json({ error: "No draft to delete." });
            }
            await DatabaseService.dropDatabase(draftDb);
            await PoolService.close(draftDb);

            await systemPool.query(
                `UPDATE system.projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{draft_sync_active}', 'false'::jsonb) WHERE slug = $1`,
                [r.project.slug]
            );

            res.json({ success: true, message: "Draft environment discarded." });
        } catch (e: any) { next(e); }
    }

    static async deployDraft(req: CascataRequest, res: any, next: any) {
        try {
            const { strategy, sql, dry_run, data_strategy, data_plan } = req.body;
            const liveDb = r.project.db_name;
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
                        [r.project.slug, JSON.stringify({ backup_db: backupDb, reason: 'pre_deploy' })]
                    );

                    console.log(`[Deploy] Safety snapshot created: ${backupDb}`);
                } catch (e: any) {
                    console.error('[Deploy] FATAL: Failed to create safety snapshot. Aborting deploy.', e);
                    return res.status(500).json({ error: "Safety Snapshot Failed. Deploy aborted to protect data." });
                }
            }
            // ----------------------------------------------

            if (strategy === 'merge') {
                // --- SELF-SUFFICIENT SQL GENERATION ---
                // The frontend may send the `sql` from getDiff()'s generated_sql,
                // but if it's missing (e.g., stale state, race condition), we regenerate
                // the migration SQL server-side instead of rejecting the request.
                let migrationSql: string = (sql && typeof sql === 'string' && sql.trim()) ? sql : '';

                if (!migrationSql) {
                    console.log('[Deploy] No SQL provided by client. Regenerating migration server-side...');
                    try {
                        const freshDiff = await BranchController.generateDiffInternal(liveDb, draftDb);
                        migrationSql = freshDiff.generated_sql || '';
                        console.log(`[Deploy] Server-side SQL generated (${migrationSql.length} chars).`);
                    } catch (diffErr: any) {
                        console.error('[Deploy] Failed to generate server-side SQL:', diffErr);
                        return res.status(500).json({ error: "Failed to generate migration SQL.", detail: diffErr.message });
                    }
                }

                const livePool = await PoolService.get(liveDb, { useDirect: true });
                const client = await livePool.connect();

                try {
                    await client.query('BEGIN');
                    await client.query("SET LOCAL statement_timeout = '60s'");

                    if (migrationSql && migrationSql.trim()) {
                        const cleanSql = migrationSql
                            .replace(/BEGIN\s*;?/gi, '')
                            .replace(/COMMIT\s*;?/gi, '')
                            .replace(/ROLLBACK\s*;?/gi, '');

                        await client.query(cleanSql);
                        console.log('[Deploy] Schema SQL executed successfully.');
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
                        [r.project.slug]
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
                    [r.project.slug]
                );

                res.json({ success: true, message: "Environment swapped successfully.", backup_id: backupDb });
            }

        } catch (e: any) { next(e); }
    }

    static async getDiff(req: CascataRequest, res: any, next: any) {
        try {
            const liveDb = r.project.db_name;
            const draftDb = `${liveDb}_draft`;

            if (!(await DatabaseService.dbExists(draftDb))) {
                return res.status(404).json({ error: "Draft environment not active." });
            }

            const diffResult = await BranchController.generateDiffInternal(liveDb, draftDb);
            res.json({ diff: diffResult });
        } catch (e: any) { next(e); }
    }

    /**
     * generateDiffInternal — Core Schema Diff Engine v4.0
     * 
     * Pure logic method with NO req/res dependency. Can be called:
     * - From the GET /diff endpoint (for UI preview)
     * - From the POST /deploy endpoint (server-side SQL regeneration fallback)
     * 
     * Returns the full diff object including `generated_sql`.
     */
    static async generateDiffInternal(liveDb: string, draftDb: string): Promise<any> {
        const livePool = await PoolService.get(liveDb, { useDirect: true });
        const draftPool = await PoolService.get(draftDb, { useDirect: true });

        // --- SYSTEM-MANAGED OBJECTS EXCLUSION LIST ---
        // These are infrastructure functions/triggers auto-created by Cascata.
        // They must NEVER appear in user-facing diffs or migration SQL, because:
        // 1. They already exist on the Live DB (injected during project creation)
        // 2. Re-creating them would be a no-op at best, or break the lock engine at worst.
        const SYSTEM_FUNCTION_NAMES = new Set([
            'notify_changes',                  // Core realtime event broadcaster
            'uuid_generate_v4',                // Extension: uuid-ossp
            'uuid_generate_v1',                // Extension: uuid-ossp
            'uuid_nil',                        // Extension: uuid-ossp
            'gen_random_uuid',                 // Extension: pgcrypto
            'gen_random_bytes',                // Extension: pgcrypto
        ]);
        const SYSTEM_FUNCTION_PREFIXES = [
            'pgp_',                            // Extension: pgcrypto family
            'armor',                           // Extension: pgcrypto
            'dearmor',                         // Extension: pgcrypto
            'crypt',                           // Extension: pgcrypto
            'digest',                          // Extension: pgcrypto
            'hmac',                            // Extension: pgcrypto
        ];
        const SYSTEM_TRIGGER_SUFFIXES = [
            '_changes',                        // Auto-created notify_changes() trigger per table
        ];
        const SYSTEM_TRIGGER_PREFIXES = [
            'trg_dynamic_locks',               // Tier-3 Padlock engine trigger
            'ensure_temporal_integrity_',       // Auto-created temporal column lock trigger
        ];

        const isSystemFunction = (name: string): boolean => {
            if (SYSTEM_FUNCTION_NAMES.has(name)) return true;
            if (SYSTEM_FUNCTION_PREFIXES.some(p => name.startsWith(p))) return true;
            // Exclude temporal lock functions auto-generated by createTable
            if (name.startsWith('lock_temporal_state_')) return true;
            return false;
        };

        const isSystemTrigger = (name: string): boolean => {
            if (SYSTEM_TRIGGER_SUFFIXES.some(s => name.endsWith(s))) return true;
            if (SYSTEM_TRIGGER_PREFIXES.some(p => name.startsWith(p))) return true;
            return false;
        };

        const getIntrospection = async (pool: Pool) => {
            // --- STRUCTURAL INTROSPECTION ---
            // Each query targets a specific PostgreSQL catalog to extract the full
            // structural fingerprint of the schema. All queries are schema-scoped
            // to 'public' to avoid capturing system/extension internals.

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

            // --- FUNCTIONS / RPCs ---
            // Extracts user-defined functions in the 'public' schema.
            // pg_get_functiondef() returns the full CREATE OR REPLACE FUNCTION body.
            // pg_get_function_identity_arguments() returns the canonical signature (used as diff key).
            // We exclude extension-owned functions (deptype = 'e') because they are managed
            // by CREATE EXTENSION, not by user migrations.
            const functions = await pool.query(`
                    SELECT 
                        p.proname AS name,
                        pg_get_functiondef(p.oid) AS definition,
                        pg_get_function_identity_arguments(p.oid) AS args_signature
                    FROM pg_proc p
                    JOIN pg_namespace n ON p.pronamespace = n.oid
                    WHERE n.nspname = 'public'
                      AND p.prokind IN ('f', 'p')
                      AND NOT EXISTS (
                          SELECT 1 FROM pg_depend d 
                          WHERE d.objid = p.oid AND d.deptype = 'e'
                      )
                    ORDER BY p.proname
                `);

            // --- TRIGGERS ---
            // Extracts user-defined triggers on tables in the 'public' schema.
            // pg_get_triggerdef() returns the full CREATE TRIGGER statement.
            // We filter out internal triggers (tgisinternal = true) which are
            // constraint-enforcement triggers managed by PostgreSQL itself.
            const triggers = await pool.query(`
                    SELECT 
                        t.tgname AS name,
                        c.relname AS table_name,
                        pg_get_triggerdef(t.oid) AS definition
                    FROM pg_trigger t
                    JOIN pg_class c ON t.tgrelid = c.oid
                    JOIN pg_namespace n ON c.relnamespace = n.oid
                    WHERE n.nspname = 'public'
                      AND NOT t.tgisinternal
                    ORDER BY c.relname, t.tgname
                `);

            return {
                cols: tables.rows,
                props: tableProps.rows,
                idxs: indexes.rows,
                pols: policies.rows,
                fks: constraints.rows,
                funcs: functions.rows,
                trigs: triggers.rows
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
            added_functions: [],
            modified_functions: [],
            added_triggers: [],
            modified_triggers: [],
            data_summary: dataAnalysis
        };

        let sql = `-- Cascata Intelligent Migration v4.0\n-- Generated at ${new Date().toISOString()}\n-- Includes: Tables, Columns, Indexes, RLS, Functions/RPCs, Triggers\n\n`;

        // ╔══════════════════════════════════════════════╗
        // ║  PHASE 1: CREATE NEW TABLES                 ║
        // ╚══════════════════════════════════════════════╝
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

        // ╔══════════════════════════════════════════════╗
        // ║  PHASE 2: MODIFY EXISTING TABLES            ║
        // ╚══════════════════════════════════════════════╝
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

        // ╔══════════════════════════════════════════════╗
        // ║  PHASE 3: SYNC INDEXES                      ║
        // ╚══════════════════════════════════════════════╝
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

        // ╔══════════════════════════════════════════════╗
        // ║  PHASE 4: SYNC RLS POLICIES                 ║
        // ╚══════════════════════════════════════════════╝
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

        // ╔══════════════════════════════════════════════╗
        // ║  PHASE 5: SYNC FUNCTIONS / RPCs             ║
        // ╚══════════════════════════════════════════════╝
        // Functions are compared by their unique identity: name + argument signature.
        // If a function exists in Draft but not in Live → NEW (CREATE).
        // If it exists in both but the definition differs → MODIFIED (CREATE OR REPLACE).
        // CREATE OR REPLACE is inherently idempotent, making this safe for re-runs.
        {
            // Filter out system-managed functions from both sides
            const draftFuncs = draftMeta.funcs.filter(f => !isSystemFunction(f.name));
            const liveFuncs = liveMeta.funcs.filter(f => !isSystemFunction(f.name));

            // Build lookup map: "funcname(arg1_type, arg2_type)" → definition
            const liveFuncMap = new Map<string, string>();
            for (const f of liveFuncs) {
                const key = `${f.name}(${f.args_signature})`;
                liveFuncMap.set(key, f.definition);
            }

            const funcChanges: Array<{ name: string; signature: string; type: 'CREATE' | 'UPDATE'; definition: string }> = [];

            for (const f of draftFuncs) {
                const key = `${f.name}(${f.args_signature})`;
                const liveDefinition = liveFuncMap.get(key);

                if (!liveDefinition) {
                    // Function exists in Draft but not in Live → NEW
                    funcChanges.push({ name: f.name, signature: f.args_signature, type: 'CREATE', definition: f.definition });
                } else if (liveDefinition !== f.definition) {
                    // Function exists in both but body/return type/volatility changed → MODIFIED
                    funcChanges.push({ name: f.name, signature: f.args_signature, type: 'UPDATE', definition: f.definition });
                }
                // Identical functions are silently skipped (no diff)
            }

            if (funcChanges.length > 0) {
                sql += `\n-- ╔══════════════════════════════════════════════╗\n`;
                sql += `-- ║  FUNCTIONS / RPCs                              ║\n`;
                sql += `-- ╚══════════════════════════════════════════════╝\n`;

                for (const fc of funcChanges) {
                    const label = fc.type === 'CREATE' ? 'NEW FUNCTION' : 'MODIFIED FUNCTION';
                    sql += `-- [${label}] ${fc.name}(${fc.signature})\n`;
                    // pg_get_functiondef already returns a complete "CREATE OR REPLACE FUNCTION" statement.
                    // We just need to append the semicolon.
                    sql += `${fc.definition};\n\n`;

                    if (fc.type === 'CREATE') {
                        changes.added_functions.push({ name: fc.name, signature: fc.signature });
                    } else {
                        changes.modified_functions.push({ name: fc.name, signature: fc.signature });
                    }
                }
            }
        }

        // ╔══════════════════════════════════════════════╗
        // ║  PHASE 6: SYNC TRIGGERS                     ║
        // ╚══════════════════════════════════════════════╝
        // Triggers are compared by their unique identity: name + table.
        // If a trigger exists in Draft but not in Live → NEW.
        // If it exists in both but the definition differs → MODIFIED.
        // Trigger modification requires DROP + CREATE (no "CREATE OR REPLACE TRIGGER" in PG < 14).
        // We use DROP IF EXISTS for idempotency.
        {
            // Filter out system-managed triggers from both sides
            const draftTrigs = draftMeta.trigs.filter(t => !isSystemTrigger(t.name));
            const liveTrigs = liveMeta.trigs.filter(t => !isSystemTrigger(t.name));

            // Build lookup map: "trigger_name::table_name" → definition
            const liveTrigMap = new Map<string, string>();
            for (const t of liveTrigs) {
                const key = `${t.name}::${t.table_name}`;
                liveTrigMap.set(key, t.definition);
            }

            const trigChanges: Array<{ name: string; table: string; type: 'CREATE' | 'UPDATE'; definition: string }> = [];

            for (const t of draftTrigs) {
                const key = `${t.name}::${t.table_name}`;
                const liveDefinition = liveTrigMap.get(key);

                if (!liveDefinition) {
                    // Trigger exists in Draft but not in Live → NEW
                    trigChanges.push({ name: t.name, table: t.table_name, type: 'CREATE', definition: t.definition });
                } else if (liveDefinition !== t.definition) {
                    // Trigger exists in both but timing/events/function changed → MODIFIED
                    trigChanges.push({ name: t.name, table: t.table_name, type: 'UPDATE', definition: t.definition });
                }
            }

            if (trigChanges.length > 0) {
                sql += `\n-- ╔══════════════════════════════════════════════╗\n`;
                sql += `-- ║  TRIGGERS                                      ║\n`;
                sql += `-- ╚══════════════════════════════════════════════╝\n`;

                for (const tc of trigChanges) {
                    const label = tc.type === 'CREATE' ? 'NEW TRIGGER' : 'MODIFIED TRIGGER';
                    sql += `-- [${label}] ${tc.name} ON ${tc.table}\n`;
                    // For modified triggers, we must drop first (PG has no CREATE OR REPLACE TRIGGER before v14)
                    if (tc.type === 'UPDATE') {
                        sql += `DROP TRIGGER IF EXISTS "${tc.name}" ON public."${tc.table}";\n`;
                    }
                    // pg_get_triggerdef returns the full CREATE TRIGGER statement
                    sql += `${tc.definition};\n\n`;

                    if (tc.type === 'CREATE') {
                        changes.added_triggers.push({ name: tc.name, table: tc.table });
                    } else {
                        changes.modified_triggers.push({ name: tc.name, table: tc.table });
                    }
                }
            }
        }

        // ╔══════════════════════════════════════════════╗
        // ║  PHASE 7: PERMISSION GRANTS (SAFETY NET)    ║
        // ╚══════════════════════════════════════════════╝
        // After all structural changes, ensure new objects are accessible
        // by the standard Cascata roles.
        sql += `\n-- [PERMISSION GRANTS] Ensure new objects are accessible\n`;
        sql += `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;\n`;
        sql += `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;\n`;

        return {
            ...changes,
            generated_sql: sql
        };
    }
}
