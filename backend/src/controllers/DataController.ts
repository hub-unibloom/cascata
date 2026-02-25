
import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { queryWithRLS, quoteId, parseColumnFormat, validateFormatPattern } from '../utils/index.js';
import { DatabaseService } from '../../services/DatabaseService.js';
import { PostgrestService } from '../../services/PostgrestService.js';
import { OpenApiService } from '../../services/OpenApiService.js';
import { ExtensionService } from '../../services/ExtensionService.js';
import { systemPool } from '../config/main.js';

export class DataController {

    // --- HELPER: SCHEMA SECURITY GUARD ---
    private static checkSchemaAccess(req: CascataRequest): boolean {
        // 1. Admin/Dashboard always allowed
        if (req.isSystemRequest) return true;

        // 2. Explicit Opt-in for FlutterFlow/AppSmith/OpenAPI
        if (req.project.metadata?.schema_exposure === true) return true;

        return false;
    }

    // --- EXTENSIONS MANAGEMENT (Phantom Injection Architecture) ---

    /**
     * Lists ALL extensions with enriched metadata:
     * - Native extensions (available in Alpine base image)
     * - Preloaded extensions (installed via Dockerfile)
     * - Phantom extensions (injectable from Docker images)
     * - Installed status per project
     * - Tier classification and source image info
     */
    static async listExtensions(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        try {
            const enriched = await ExtensionService.listAvailableEnriched(req.projectPool!);
            res.json(enriched);
        } catch (e: any) { next(e); }
    }

    /**
     * Install an extension. For phantom extensions, this triggers
     * Docker image extraction first, then CREATE EXTENSION.
     * For native extensions, goes straight to CREATE EXTENSION.
     */
    static async installExtension(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { name, schema } = req.body;

        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
            return res.status(400).json({ error: 'Invalid extension name.' });
        }

        try {
            const result = await ExtensionService.installExtension(
                req.projectPool!,
                req.project.slug,
                name,
                schema || 'public'
            );
            res.json(result);
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    }

    /**
     * Uninstall an extension from a project.
     */
    static async uninstallExtension(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { name, cascade } = req.body;

        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
            return res.status(400).json({ error: 'Invalid extension name.' });
        }

        try {
            const result = await ExtensionService.uninstallExtension(
                req.projectPool!,
                req.project.slug,
                name,
                cascade === true
            );
            res.json(result);
        } catch (e: any) {
            res.status(400).json({ error: e.message });
        }
    }

    /**
     * Get real-time status of an extension installation (polling endpoint).
     * Used by the frontend to track Phantom Injection progress.
     */
    static async getExtensionInstallStatus(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { name } = req.params;

        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
            return res.status(400).json({ error: 'Invalid extension name.' });
        }

        try {
            const status = ExtensionService.getInstallStatus(name);
            res.json(status);
        } catch (e: any) { next(e); }
    }

    // --- DATA OPERATIONS ---

    static async getSchemas(req: CascataRequest, res: any, next: any) {
        // Direct pool query — bypasses queryWithRLS which sets cascata_api_role
        // that may lack USAGE on user-created schemas.
        // This endpoint is admin-only (dashboard always sends system token).
        try {
            const result = await req.projectPool!.query(`
                SELECT schema_name as name 
                FROM information_schema.schemata 
                WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                  AND schema_name NOT LIKE 'pg_temp_%'
                  AND schema_name NOT LIKE 'pg_toast_temp_%'
                ORDER BY schema_name
            `);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async listTables(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled. Enable "Schema Exposure" in settings.' });
        }
        try {
            const schema = req.query.schema || 'public';
            const result = await queryWithRLS(req, async (client) => {
                return await client.query(`
                    SELECT table_name as name, table_schema as schema 
                    FROM information_schema.tables 
                    WHERE table_schema = $1 
                    AND table_type = 'BASE TABLE' 
                    AND table_name NOT LIKE '\\_deleted\\_%'
                    ORDER BY table_name
                `, [schema]);
            });
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async queryRows(req: CascataRequest, res: any, next: any) {
        try {
            if (!req.params.tableName) throw new Error("Table name required");
            const schema = req.query.schema || 'public';
            const safeSchema = quoteId(schema as string);
            const safeTable = quoteId(req.params.tableName);
            const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
            const offset = parseInt(req.query.offset as string) || 0;
            const sortColumn = req.query.sortColumn as string;
            const sortDirection = req.query.sortDirection as string === 'desc' ? 'DESC' : 'ASC';

            let query = `SELECT * FROM ${safeSchema}.${safeTable}`;
            if (sortColumn) query += ` ORDER BY "${sortColumn}" ${sortDirection}`;
            query += ` LIMIT $1 OFFSET $2`;

            const result = await queryWithRLS(req, async (client) => {
                return await client.query(query, [limit, offset]);
            });
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async insertRows(req: CascataRequest, res: any, next: any) {
        try {
            const safeTable = quoteId(req.params.tableName);
            const { data } = req.body;
            if (!data) throw new Error("No data provided");

            const rows = Array.isArray(data) ? data : [data];
            if (rows.length === 0) return res.json([]);

            // --- FORMAT VALIDATION (Server-Side Enforcement) ---
            const schema = req.query.schema || 'public';
            const safeSchema = quoteId(schema as string);

            const commentRes = await req.projectPool!.query(
                `SELECT c.column_name, col_description(
                    (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)),
                    c.ordinal_position
                ) as comment
                FROM information_schema.columns c
                WHERE c.table_schema = $2 AND c.table_name = $1`,
                [req.params.tableName, schema]
            );

            const formatMap = new Map<string, string>();
            for (const row of commentRes.rows) {
                const parsed = parseColumnFormat(row.comment);
                if (parsed.formatPattern) {
                    formatMap.set(row.column_name, parsed.formatPattern);
                }
            }

            // Validate all rows against format patterns
            if (formatMap.size > 0) {
                for (let i = 0; i < rows.length; i++) {
                    for (const [colName, pattern] of formatMap) {
                        const value = rows[i][colName];
                        if (value !== undefined && value !== null && value !== '') {
                            const result = validateFormatPattern(String(value), pattern);
                            if (!result.valid) {
                                return res.status(400).json({
                                    error: `Format Validation Failed on column "${colName}" (row ${i + 1}): ${result.error}`
                                });
                            }
                        }
                    }
                }
            }
            // --- END FORMAT VALIDATION ---

            const allKeys = new Set<string>();
            rows.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));

            const keysArray = Array.from(allKeys);
            if (keysArray.length === 0) throw new Error("Cannot insert empty objects");

            const columns = keysArray.map(quoteId).join(', ');
            const flatValues: any[] = [];

            const valuesPlaceholder = rows.map((row) => {
                const rowPlaceholders = keysArray.map((key) => {
                    const val = row[key];
                    if (val === undefined) {
                        return 'DEFAULT';
                    } else {
                        flatValues.push(val);
                        return `$${flatValues.length}`;
                    }
                });
                return `(${rowPlaceholders.join(', ')})`;
            }).join(', ');

            if (flatValues.length > 65000) {
                throw new Error("Batch too large. Reduce rows or columns.");
            }

            const result = await queryWithRLS(req, async (client) => {
                return await client.query(`INSERT INTO ${safeSchema}.${safeTable} (${columns}) VALUES ${valuesPlaceholder} RETURNING *`, flatValues);
            });
            res.status(201).json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async updateRows(req: CascataRequest, res: any, next: any) {
        try {
            const schema = req.query.schema || 'public';
            const safeSchema = quoteId(schema as string);
            const safeTable = quoteId(req.params.tableName);
            const { data, pkColumn, pkValue } = req.body;
            if (!data || !pkColumn || pkValue === undefined) throw new Error("Missing data or PK");

            // --- FORMAT VALIDATION (Server-Side Enforcement) ---
            const commentRes = await req.projectPool!.query(
                `SELECT c.column_name, col_description(
                    (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)),
                    c.ordinal_position
                ) as comment
                FROM information_schema.columns c
                WHERE c.table_schema = $2 AND c.table_name = $1`,
                [req.params.tableName, schema]
            );

            for (const row of commentRes.rows) {
                const parsed = parseColumnFormat(row.comment);
                if (parsed.formatPattern && data[row.column_name] !== undefined && data[row.column_name] !== null && data[row.column_name] !== '') {
                    const result = validateFormatPattern(String(data[row.column_name]), parsed.formatPattern);
                    if (!result.valid) {
                        return res.status(400).json({
                            error: `Format Validation Failed on column "${row.column_name}": ${result.error}`
                        });
                    }
                }
            }
            // --- END FORMAT VALIDATION ---

            const updates = Object.keys(data).map((k, i) => `${quoteId(k)} = $${i + 1}`).join(', ');
            const values = Object.values(data);
            const pkValIndex = values.length + 1;
            const result = await queryWithRLS(req, async (client) => {
                return await client.query(`UPDATE ${safeSchema}.${safeTable} SET ${updates} WHERE ${quoteId(pkColumn)} = $${pkValIndex} RETURNING *`, [...values, pkValue]);
            });
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async deleteRows(req: CascataRequest, res: any, next: any) {
        try {
            const schema = req.query.schema || 'public';
            const safeSchema = quoteId(schema as string);
            const tableName = req.params.tableName;
            const safeTable = quoteId(tableName);
            const { ids } = req.body;

            if (!ids || !Array.isArray(ids) || ids.length === 0) throw new Error("Invalid delete request: 'ids' array required");

            const pkQuery = `
                SELECT kcu.column_name 
                FROM information_schema.table_constraints tco
                JOIN information_schema.key_column_usage kcu 
                  ON kcu.constraint_name = tco.constraint_name
                  AND kcu.constraint_schema = tco.constraint_schema
                WHERE tco.constraint_type = 'PRIMARY KEY'
                  AND tco.table_schema = $1
                  AND tco.table_name = $2
            `;

            const pkRes = await req.projectPool!.query(pkQuery, [schema, tableName]);

            if (pkRes.rows.length === 0) {
                return res.status(400).json({ error: "Safety Block: Table has no Primary Key. Use SQL Editor." });
            }

            if (pkRes.rows.length > 1) {
                return res.status(400).json({
                    error: "Safety Block: Composite Primary Keys not supported via simple list deletion. Use SQL Editor."
                });
            }

            const realPkColumn = pkRes.rows[0].column_name;

            const result = await queryWithRLS(req, async (client) => {
                return await client.query(`DELETE FROM ${safeSchema}.${safeTable} WHERE ${quoteId(realPkColumn)} = ANY($1) RETURNING *`, [ids]);
            });
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    // --- RPC & FUNCTIONS ---

    static async executeRpc(req: CascataRequest, res: any, next: any) {
        const schema = req.query.schema || 'public';
        const safeSchema = quoteId(schema as string);
        const params = req.body || {};
        const namedPlaceholders = Object.keys(params).map((k, i) => `${quoteId(k)} => $${i + 1}`).join(', ');
        const values = Object.values(params);

        try {
            const rows = await queryWithRLS(req, async (client) => {
                const result = await client.query(`SELECT * FROM ${safeSchema}.${quoteId(req.params.name)}(${namedPlaceholders})`, values);
                return result.rows;
            });
            res.json(rows);
        } catch (e: any) { next(e); }
    }

    static async listFunctions(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled.' });
        }
        try {
            const schema = req.query.schema || 'public';
            const result = await req.projectPool!.query(`SELECT routine_name as name FROM information_schema.routines WHERE routine_schema = $1 AND routine_name NOT LIKE 'uuid_%' AND routine_name NOT LIKE 'pgp_%'`, [schema]);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async listTriggers(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled.' });
        }
        try {
            const result = await req.projectPool!.query("SELECT trigger_name as name FROM information_schema.triggers");
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async getFunctionDefinition(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled.' });
        }
        try {
            const schema = req.query.schema || 'public';
            const defResult = await req.projectPool!.query("SELECT pg_get_functiondef(p.oid) as def FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = $1 AND n.nspname = $2", [req.params.name, schema]);
            const argsResult = await req.projectPool!.query(`SELECT parameter_name as name, data_type as type, parameter_mode as mode FROM information_schema.parameters WHERE specific_name = (SELECT specific_name FROM information_schema.routines WHERE routine_name = $1 AND routine_schema = $2 LIMIT 1) ORDER BY ordinal_position ASC`, [req.params.name, schema]);
            if (defResult.rows.length === 0) return res.status(404).json({ error: 'Function not found' });
            res.json({ definition: defResult.rows[0].def, args: argsResult.rows });
        } catch (e: any) { next(e); }
    }

    // --- SCHEMA & METADATA ---

    static async getColumns(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled.' });
        }
        try {
            const schema = req.query.schema || 'public';
            const result = await req.projectPool!.query(
                `SELECT 
                    c.column_name as name, 
                    c.data_type as type, 
                    c.is_nullable, 
                    c.column_default as "defaultValue",
                    EXISTS (
                        SELECT 1 FROM information_schema.key_column_usage kcu 
                        WHERE kcu.table_name = $1 AND kcu.table_schema = $2 AND kcu.column_name = c.column_name
                    ) as "isPrimaryKey",
                    col_description(
                        (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)),
                        c.ordinal_position
                    ) as "rawComment"
                FROM information_schema.columns c 
                WHERE c.table_schema = $2 AND c.table_name = $1
                ORDER BY c.ordinal_position`,
                [req.params.tableName, schema]
            );

            // Parse format patterns from comments
            const enriched = result.rows.map((row: any) => {
                const parsed = parseColumnFormat(row.rawComment);
                return {
                    ...row,
                    description: parsed.description || '',
                    formatPattern: parsed.formatPattern || null,
                    rawComment: undefined // Don't expose raw comment to client
                };
            });

            res.json(enriched);
        } catch (e: any) { next(e); }
    }

    static async runRawQuery(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') { res.status(403).json({ error: 'Only Service Role can execute raw SQL' }); return; }
        try {
            const start = Date.now();
            const client = await req.projectPool!.connect();
            try {
                await client.query("SET LOCAL statement_timeout = '60s'");
                const result = await client.query(req.body.sql);

                // Auto-grant: After DDL, ensure cascata_api_role can access all user schemas
                const cmd = (result.command || '').toUpperCase();
                if (['CREATE', 'ALTER', 'DROP'].includes(cmd)) {
                    try {
                        await client.query(`
                            DO $$ DECLARE s TEXT; BEGIN
                                FOR s IN SELECT schema_name FROM information_schema.schemata
                                    WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                                    AND schema_name NOT LIKE 'pg_temp_%'
                                    AND schema_name NOT LIKE 'pg_toast_temp_%'
                                LOOP
                                    EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role, cascata_api_role', s);
                                    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO service_role, cascata_api_role', s);
                                    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO service_role, cascata_api_role', s);
                                    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO anon, authenticated', s);
                                    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO anon, authenticated', s);
                                    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated', s);
                                    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated', s);
                                END LOOP;
                            END $$;
                        `);
                    } catch (grantErr) {
                        console.warn('[runRawQuery] Auto-grant failed (non-fatal):', grantErr);
                    }
                }

                res.json({ rows: result.rows, rowCount: result.rowCount, command: result.command, duration: Date.now() - start });
            } finally {
                client.release();
            }
        } catch (e: any) {
            if (e.code) {
                return res.status(400).json({ error: e.message, code: e.code, position: e.position });
            }
            next(e);
        }
    }

    static async createTable(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) { res.status(403).json({ error: 'Only Dashboard can create tables.' }); return; }
        const { name, columns, description } = req.body;
        const schema = req.query.schema || 'public';
        const safeSchema = quoteId(schema as string);
        try {
            if (req.projectPool) await DatabaseService.validateTableDefinition(req.projectPool, name, columns);
            const safeName = quoteId(name);
            const colDefs = columns.map((c: any) => {
                let def = `${quoteId(c.name)} ${c.type}`;
                if (c.primaryKey) def += ' PRIMARY KEY';
                if (!c.nullable && !c.primaryKey) def += ' NOT NULL';
                if (c.default) def += ` DEFAULT ${c.default}`;
                if (c.isUnique) def += ' UNIQUE';
                if (c.foreignKey) def += ` REFERENCES ${quoteId(c.foreignKey.table)}(${quoteId(c.foreignKey.column)})`;
                return def;
            }).join(', ');
            const sql = `CREATE TABLE ${safeSchema}.${safeName} (${colDefs});`;
            await req.projectPool!.query(sql);
            await req.projectPool!.query(`ALTER TABLE ${safeSchema}.${safeName} ENABLE ROW LEVEL SECURITY`);
            await req.projectPool!.query(`CREATE TRIGGER ${name}_changes AFTER INSERT OR UPDATE OR DELETE ON ${safeSchema}.${safeName} FOR EACH ROW EXECUTE FUNCTION public.notify_changes();`);
            if (description) await req.projectPool!.query(`COMMENT ON TABLE ${safeSchema}.${safeName} IS $1`, [description]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    // --- RECYCLE BIN & SOFT DELETE ---

    static async deleteTable(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) { res.status(403).json({ error: 'Only Dashboard can delete tables.' }); return; }
        const { mode } = req.body;
        const schema = req.query.schema || 'public';
        const safeSchema = quoteId(schema as string);
        try {
            if (mode === 'CASCADE' || mode === 'RESTRICT') {
                const cascadeSql = mode === 'CASCADE' ? 'CASCADE' : '';
                await req.projectPool!.query(`DROP TABLE ${safeSchema}.${quoteId(req.params.table)} ${cascadeSql}`);
            } else {
                const deletedName = `_deleted_${Date.now()}_${req.params.table}`;
                await req.projectPool!.query(`ALTER TABLE ${safeSchema}.${quoteId(req.params.table)} RENAME TO ${quoteId(deletedName)}`);
            }
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async listRecycleBin(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
        try {
            const schema = req.query.schema || 'public';
            const result = await req.projectPool!.query("SELECT table_name as name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '\\_deleted\\_%'", [schema]);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async restoreTable(req: CascataRequest, res: any, next: any) {
        if (!req.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
        try {
            const schema = req.query.schema || 'public';
            const safeSchema = quoteId(schema as string);
            const originalName = req.params.table.replace(/^_deleted_\d+_/, '');
            await req.projectPool!.query(`ALTER TABLE ${safeSchema}.${quoteId(req.params.table)} RENAME TO ${quoteId(originalName)}`);
            res.json({ success: true, restoredName: originalName });
        } catch (e: any) { next(e); }
    }

    // --- SYSTEM ASSETS & SETTINGS (GLOBAL via systemPool) ---
    // (Omitted methods remain unchanged for brevity, but are required in full implementation)
    // ... getUiSettings, saveUiSettings, getAssets, upsertAsset, deleteAsset, getAssetHistory ...

    static async getUiSettings(req: CascataRequest, res: any, next: any) { try { const result = await systemPool.query('SELECT settings FROM system.ui_settings WHERE project_slug = $1 AND table_name = $2', [req.params.slug, req.params.table]); res.json(result.rows[0]?.settings || {}); } catch (e: any) { next(e); } }
    static async saveUiSettings(req: CascataRequest, res: any, next: any) { try { await systemPool.query("INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ($1, $2, $3) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $3", [req.params.slug, req.params.table, req.body.settings]); res.json({ success: true }); } catch (e: any) { next(e); } }
    static async getAssets(req: CascataRequest, res: any, next: any) { try { const result = await systemPool.query('SELECT * FROM system.assets WHERE project_slug = $1', [req.project.slug]); res.json(result.rows); } catch (e: any) { next(e); } }
    static async upsertAsset(req: CascataRequest, res: any, next: any) {
        const { id, name, type, parent_id, metadata } = req.body;
        try {
            let assetId = id;
            const safeParentId = (parent_id === 'root' || parent_id === '') ? null : parent_id;
            if (id) {
                // CRITICAL FIX: Ensure the asset being updated belongs to the current project
                const checkRes = await systemPool.query('SELECT 1 FROM system.assets WHERE id = $1 AND project_slug = $2', [id, req.project.slug]);
                if (checkRes.rowCount === 0) return res.status(404).json({ error: 'Asset not found or unauthorized' });

                let query = 'UPDATE system.assets SET name=$1, metadata=$2 WHERE id=$3 AND project_slug=$4 RETURNING *';
                let params = [name, metadata, id, req.project.slug];
                if (parent_id !== undefined) {
                    query = 'UPDATE system.assets SET name=$1, metadata=$2, parent_id=$5 WHERE id=$3 AND project_slug=$4 RETURNING *';
                    params = [name, metadata, id, req.project.slug, safeParentId];
                }
                const upd = await systemPool.query(query, params);
                assetId = upd.rows[0].id;
                res.json(upd.rows[0]);
            } else {
                const ins = await systemPool.query('INSERT INTO system.assets (project_slug, name, type, parent_id, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *', [req.project.slug, name, type, safeParentId, metadata]);
                assetId = ins.rows[0].id;
                res.json(ins.rows[0]);
            }
            if (metadata?.sql) systemPool.query('INSERT INTO system.asset_history (asset_id, project_slug, content, metadata, created_by) VALUES ($1, $2, $3, $4, $5)', [assetId, req.project.slug, metadata.sql, metadata, req.userRole]);
        } catch (e: any) { next(e); }
    }
    static async deleteAsset(req: CascataRequest, res: any, next: any) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return res.json({ success: true });
        try {
            // CRITICAL FIX: Ensure the asset being deleted belongs to the current project
            await systemPool.query('DELETE FROM system.assets WHERE id=$1 AND project_slug=$2', [req.params.id, req.project.slug]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }
    static async getAssetHistory(req: CascataRequest, res: any, next: any) {
        try {
            // SECURITY FIX: Join to assets to enforce project_slug isolation (prevents IDOR)
            const result = await systemPool.query(
                `SELECT h.id, h.created_at, h.created_by, h.metadata 
                 FROM system.asset_history h
                 INNER JOIN system.assets a ON a.id = h.asset_id
                 WHERE h.asset_id = $1 AND a.project_slug = $2
                 ORDER BY h.created_at DESC LIMIT 50`,
                [req.params.id, req.project.slug]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async getStats(req: CascataRequest, res: any, next: any) {
        try {
            const logsRes = await systemPool.query(`
                SELECT 
                    to_char(created_at, 'HH24:00') as name, 
                    count(*) as requests,
                    count(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 END) as success,
                    count(CASE WHEN status_code >= 400 THEN 1 END) as error
                FROM system.api_logs 
                WHERE project_slug = $1 
                  AND created_at > NOW() - INTERVAL '24 hours'
                GROUP BY 1 
                ORDER BY 1
            `, [req.project.slug]);

            const client = await req.projectPool!.connect();
            try {
                await client.query("RESET ROLE");
                const [tables, users, size] = await Promise.all([
                    client.query("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '_deleted_%'"),
                    client.query("SELECT count(*) FROM auth.users"),
                    client.query("SELECT pg_size_pretty(pg_database_size(current_database()))")
                ]);

                res.json({
                    tables: parseInt(tables.rows[0].count),
                    users: parseInt(users.rows[0].count),
                    size: size.rows[0].pg_size_pretty,
                    throughput: logsRes.rows.map(r => ({
                        name: r.name,
                        requests: parseInt(r.requests),
                        success: parseInt(r.success),
                        error: parseInt(r.error)
                    }))
                });
            } finally {
                client.release();
            }
        } catch (e: any) { next(e); }
    }

    // --- POSTGREST COMPATIBILITY ---

    static async handlePostgrest(req: CascataRequest, res: any, next: any) {
        if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
        try {
            const { text, values, countQuery } = PostgrestService.buildQuery(
                req.params.tableName,
                req.method,
                req.query,
                req.body,
                req.headers
            );

            const result = await queryWithRLS(req, async (client) => {
                if (countQuery) {
                    await client.query("SET LOCAL statement_timeout = '5s'");
                    const countRes = await client.query(countQuery, values);
                    const total = parseInt((countRes.rows[0] as any)?.total || '0');
                    const mainRes = await client.query(text, values);
                    const offset = parseInt(req.query.offset as string || '0');
                    const start = offset;
                    const end = Math.min(offset + mainRes.rows.length - 1, total - 1);
                    res.setHeader('Content-Range', mainRes.rows.length === 0 ? `*/${total}` : `${start}-${end}/${total}`);
                    return mainRes;
                }
                return await client.query(text, values);
            });

            if (req.headers.accept === 'application/vnd.pgrst.object+json') {
                res.json(result.rows[0] || null);
            } else {
                res.json(result.rows);
            }
        } catch (e: any) { next(e); }
    }

    // --- SPEC GENERATION ---

    static async getOpenApiSpec(req: CascataRequest, res: any, next: any) {
        const r = req as CascataRequest;
        const isDiscoveryEnabled = r.project.metadata?.schema_exposure === true;
        if (!r.isSystemRequest && !isDiscoveryEnabled) {
            return res.status(403).json({ error: 'API Schema Discovery is disabled.' });
        }
        try {
            const protocol = req.headers['x-forwarded-proto'] || 'http';
            const host = req.headers.host;
            let baseUrl = '';
            if (r.project.custom_domain && host === r.project.custom_domain) {
                baseUrl = `${protocol}://${host}/rest/v1`;
            } else {
                baseUrl = `${protocol}://${host}/api/data/${r.project.slug}/rest/v1`;
            }
            const spec = await OpenApiService.generatePostgrest(
                r.project.slug,
                r.project.db_name,
                r.projectPool!,
                systemPool,
                baseUrl
            );
            res.json(spec);
        } catch (e: any) { next(e); }
    }
}
