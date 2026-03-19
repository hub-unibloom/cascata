
import { NextFunction } from 'express';
import { CascataRequest } from '../types.js';
import { queryWithRLS, quoteId, parseColumnFormat, validateFormatPattern, quotePostgresLiteral } from '../utils/index.js';
import { DatabaseService } from '../../services/DatabaseService.js';
import { PostgrestService } from '../../services/PostgrestService.js';
import { OpenApiService } from '../../services/OpenApiService.js';
import { ExtensionService } from '../../services/ExtensionService.js';
import { RateLimitService } from '../../services/RateLimitService.js';
import { AutomationService } from '../../services/AutomationService.js';
import { CronService } from '../../services/CronService.js';
import { SecurityUtils } from '../utils/SecurityUtils.js';
import { systemPool } from '../config/main.js';

export class DataController {

    /**
     * Isolates and executes a single node for testing purposes.
     * Used by the frontend to inspect node outputs and structure.
     */
    static async testNode(req: CascataRequest, res: any, next: any) {
        const r = req;
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { node, triggerPayload } = req.body;

        if (!node || !node.type) {
            return res.status(400).json({ error: 'Invalid node configuration.' });
        }

        try {
            const context: any = {
                vars: {
                    trigger: { data: triggerPayload || {} },
                    $input: triggerPayload || {}
                },
                projectSlug: r.project.slug,
                projectPool: r.projectPool!,
                userRole: r.user.role || 'authenticated',
                jwtClaims: req.user,
                dryRun: true
            };

            const result = await AutomationService.processNode(node, context);

            // Analyze keys if the result is an object or array of objects
            let detectedKeys: string[] = [];
            if (result && typeof result === 'object') {
                const sample = Array.isArray(result) ? result[0] : result;
                if (sample && typeof sample === 'object') {
                    detectedKeys = Object.keys(sample);
                }
            }

            res.json({
                success: true,
                output: result,
                keys: detectedKeys
            });
        } catch (e: any) {
            res.status(500).json({
                success: false,
                error: e.message,
                stack: process.env.NODE_ENV === 'development' ? e.stack : undefined
            });
        }
    }

    // --- HELPER: PostgreSQL Type → UNNEST Array Cast Mapper ---
    // Maps information_schema data_type/udt_name to the correct PostgreSQL array cast type
    // for use in UNNEST batch inserts. Without this, casting everything as text[] causes
    // errors for timestamptz, integer, boolean, uuid, jsonb, and other non-text types.
    private static mapPgTypeToCast(dataType: string, udtName: string): string {
        // UDT name is the most precise identifier
        const udt = (udtName || '').toLowerCase();
        const dt = (dataType || '').toLowerCase();

        // Timestamp types
        if (udt === 'timestamptz' || dt === 'timestamp with time zone') return 'timestamptz';
        if (udt === 'timestamp' || dt === 'timestamp without time zone') return 'timestamp';

        // Date/Time
        if (udt === 'date' || dt === 'date') return 'date';
        if (udt === 'time' || udt === 'timetz') return udt;
        if (udt === 'interval' || dt === 'interval') return 'interval';

        // Numeric types
        if (udt === 'int4' || dt === 'integer') return 'integer';
        if (udt === 'int8' || dt === 'bigint') return 'bigint';
        if (udt === 'int2' || dt === 'smallint') return 'smallint';
        if (udt === 'float4' || dt === 'real') return 'real';
        if (udt === 'float8' || dt === 'double precision') return 'double precision';
        if (udt === 'numeric' || dt === 'numeric') return 'numeric';

        // Boolean
        if (udt === 'bool' || dt === 'boolean') return 'boolean';

        // UUID
        if (udt === 'uuid' || dt === 'uuid') return 'uuid';

        // JSON types
        if (udt === 'jsonb') return 'jsonb';
        if (udt === 'json') return 'json';

        // Binary
        if (udt === 'bytea' || dt === 'bytea') return 'bytea';

        // Network types
        if (udt === 'inet' || udt === 'cidr' || udt === 'macaddr') return udt;

        // Text variants (varchar, char, text, etc.) — safe default
        if (dt.includes('character') || udt === 'varchar' || udt === 'bpchar' || udt === 'text') return 'text';

        // USER-DEFINED (enums, composite types) — use the udt_name directly
        if (dt === 'user-defined' && udt) return `"${udt}"`;

        // ARRAY types — pass through as the base type with [] appended by the caller
        if (dt === 'array' && udt.startsWith('_')) return udt.substring(1);

        // Fallback: text is safe because PG can implicit-cast text→most types in INSERT context
        return 'text';
    }

    // --- HELPER: SCHEMA SECURITY GUARD ---
    private static checkSchemaAccess(req: CascataRequest): boolean {
        // 1. Admin/Dashboard always allowed
        if (r.isSystemRequest) return true;

        // 2. Explicit Opt-in for FlutterFlow/AppSmith/OpenAPI
        if (r.project.metadata?.schema_exposure === true) return true;

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
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        try {
            const enriched = await ExtensionService.listAvailableEnriched(r.projectPool!);
            res.json(enriched);
        } catch (e: any) { next(e); }
    }

    /**
     * Install an extension. For phantom extensions, this triggers
     * Docker image extraction first, then CREATE EXTENSION.
     * For native extensions, goes straight to CREATE EXTENSION.
     */
    static async installExtension(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { name, schema } = req.body;

        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
            return res.status(400).json({ error: 'Invalid extension name.' });
        }

        try {
            const result = await ExtensionService.installExtension(
                r.projectPool!,
                r.project.slug,
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
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { name, cascade } = req.body;

        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
            return res.status(400).json({ error: 'Invalid extension name.' });
        }

        try {
            const result = await ExtensionService.uninstallExtension(
                r.projectPool!,
                r.project.slug,
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
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
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
            const result = await r.projectPool!.query(`
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

    static async applyMaskingTier(req: CascataRequest, responseData: any, tableName: string): Promise<any> {
        if (!responseData || !r.project.metadata?.masked_columns) return responseData;

        const masks = r.project.metadata.masked_columns[tableName] || {};
        if (Object.keys(masks).length === 0) return responseData;

        const isAdmin = r.userRole === 'service_role';

        // Lazy load SecurityUtils for decryption
        let SecurityUtils: any;
        if (isAdmin) {
            try {
                SecurityUtils = (await import('../utils/SecurityUtils.js')).SecurityUtils;
            } catch (e) { }
        }

        const apply = (row: any) => {
            if (!row) return row;
            const newRow = { ...row };
            for (const col of Object.keys(newRow)) {
                const maskType = masks[col];
                if (!maskType) continue;

                // 1. ADMIN BYPASS & AUTO-DECRYPTION (Professional Sinergy)
                if (isAdmin) {
                    if (maskType === 'encrypt' && newRow[col] && typeof newRow[col] === 'string' && newRow[col].includes(':')) {
                        try {
                            newRow[col] = SecurityUtils.decrypt(newRow[col]);
                        } catch (err) { }
                    }
                    continue; // Admin sees everything else (hide/mask/blur) unmasked
                }

                // 2. PRIVACY ENFORCEMENT (Anon/Authenticated)
                if (maskType === 'hide') {
                    delete newRow[col];
                } else if (maskType === 'mask' && newRow[col]) {
                    newRow[col] = '********';
                } else if (maskType === 'semi-mask' && newRow[col]) {
                    // Smart 25/75 Masking
                    const str = String(newRow[col]);
                    const visibleLen = Math.max(1, Math.floor(str.length * 0.25));
                    newRow[col] = str.substring(0, visibleLen) + '*'.repeat(Math.max(3, str.length - visibleLen));
                } else if (maskType === 'encrypt' && newRow[col]) {
                    newRow[col] = '[ENCRYPTED]'; // Hide ciphertext from non-admins
                } else if (maskType === 'blur' && newRow[col]) {
                    const str = String(newRow[col]);
                    if (str.length > 5) {
                        newRow[col] = `${str.substring(0, 3)}...${str.substring(str.length - 2)}`;
                    } else {
                        newRow[col] = '***';
                    }
                }
            }
            return newRow;
        };

        if (Array.isArray(responseData)) {
            return responseData.map(apply);
        } else if (typeof responseData === 'object') {
            return apply(responseData);
        }
        return responseData;
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
                // REMOVED static statement name: Dynamic SELECT * queries should NOT use named plans 
                // because column count changes frequently during development.
                return await client.query(query, [limit, offset]);
            });

            // --- CASCATA PRIVACY ENGINE (Centralized) ---
            const rows = await DataController.applyMaskingTier(req, result.rows, req.params.tableName);

            res.json(rows);
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

            const commentRes = await r.projectPool!.query(
                `SELECT c.column_name, c.data_type, c.udt_name, col_description(
                    (SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)),
                    c.ordinal_position
                ) as comment
                FROM information_schema.columns c
                WHERE c.table_schema = $2 AND c.table_name = $1`,
                [req.params.tableName, schema]
            );

            const formatMap = new Map<string, string>();
            // FIX: Build a type map so UNNEST uses the correct PostgreSQL array cast per column,
            // instead of blindly using ::text[] which breaks for timestamptz, int, bool, uuid, jsonb, etc.
            const columnTypeMap = new Map<string, string>();
            for (const row of commentRes.rows) {
                const parsed = parseColumnFormat(row.comment);
                if (parsed.formatPattern) {
                    formatMap.set(row.column_name, parsed.formatPattern);
                }
                // Map PostgreSQL data_type/udt_name to the correct array cast type
                const pgCast = DataController.mapPgTypeToCast(row.data_type, row.udt_name);
                columnTypeMap.set(row.column_name, pgCast);
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

            // --- SECURITY LOCK SANITIZER (SILENT STRIP) ---
            // Reintroduzido: O motor DDL protege os dados no banco, mas limpar as chaves localmente previne que APIs
            // que enviam dados "cegamente" quebrem. Na inserção, apenas removemos propriedades 'immutable'.
            const locks = req.project?.metadata?.locked_columns?.[req.params.tableName] || {};
            const masks = req.project?.metadata?.masked_columns?.[req.params.tableName] || {};
            rows.forEach((row: any) => {
                for (const col of Object.keys(row)) {
                    // Impede a inserção de colunas estritamente imutáveis para usarem o DEFAULT do DB
                    if (locks[col] === 'immutable') {
                        delete row[col];
                    } else if (masks[col] === 'encrypt' && row[col]) {
                        row[col] = SecurityUtils.encrypt(String(row[col]));
                    }
                }
            });

            // Se o payload ficar totalmente vazio, apenas retornamos sucesso vazio
            const validRows = rows.filter((r: any) => Object.keys(r).length > 0);
            if (validRows.length === 0) return res.status(201).json([]);

            const allKeys = new Set<string>();
            validRows.forEach((row: any) => Object.keys(row).forEach(k => allKeys.add(k)));

            const keysArray = Array.from(allKeys);
            if (keysArray.length === 0) throw new Error("Cannot insert empty objects");

            const columns = keysArray.map(quoteId).join(', ');
            const flatValues: any[] = [];

            // O SANTO GRAAL DOS BATCH INSERTS: Array Unnesting
            // Ao invez de explodir o driver com 65,000 parametros numéricos individuais ($1, $2, ... $65k)
            // Agrupamos os valores VERTICALMENTE. Teremos exatos "N" parametros, onde N = Numero de Colunas.
            // O motor do PostgreSQL (Escrito em C) expande o array para linhas nativamente.
            keysArray.forEach((key, colIndex) => {
                const columnData = rows.map(row => row[key] === undefined ? null : row[key]);
                flatValues.push(columnData); // Push the entire column as a single Array to node-pg
            });

            // FIX: Use the real column types from the database for UNNEST array casting.
            // The old hardcoded "::text[]" breaks for timestamptz, int, bool, uuid, jsonb, etc.
            // PostgreSQL does NOT do implicit text→timestamptz cast inside UNNEST.
            const unnestArgs = keysArray.map((key, i) => {
                const castType = columnTypeMap.get(key) || 'text';
                return `$${i + 1}::${castType}[]`;
            }).join(', ');

            const result = await queryWithRLS(req, async (client) => {
                return await client.query(`
                    INSERT INTO ${safeSchema}.${safeTable} (${columns})
                    SELECT * FROM UNNEST(${unnestArgs}) 
                    RETURNING *
                `, flatValues);
            });
            // --- CASCATA PRIVACY ENGINE (Centralized) ---
            const maskedRows = await DataController.applyMaskingTier(req, result.rows, req.params.tableName);
            res.status(201).json(maskedRows);
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
            const commentRes = await r.projectPool!.query(
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

            // --- SECURITY LOCK SANITIZER (SILENT STRIP) ---
            // Reintroduzido: O motor DDL rejeita brutalmente (500) queries que tocam colunas insert_only/immutable.
            // Para não quebrar o ecossistema (onde clientes muitas vezes enviam o payload inteiro via PUT/PATCH),
            // limpamos silenciosamente as chaves protegidas caso o cliente as envie.
            const locks = req.project?.metadata?.locked_columns?.[req.params.tableName] || {};
            const masks = req.project?.metadata?.masked_columns?.[req.params.tableName] || {};
            for (const col of Object.keys(data)) {
                if (locks[col] === 'insert_only' || locks[col] === 'immutable') {
                    delete data[col];
                } else if (masks[col] === 'encrypt' && data[col]) {
                    data[col] = SecurityUtils.encrypt(String(data[col]));
                }
            }

            if (Object.keys(data).length === 0) {
                // Return gracefully if payload becomes empty after stripping
                return res.json([{}]);
            }

            const updates = Object.keys(data).map((k, i) => `${quoteId(k)} = $${i + 1}`).join(', ');
            const values = Object.values(data);
            const pkValIndex = values.length + 1;
            const result = await queryWithRLS(req, async (client) => {
                return await client.query(`UPDATE ${safeSchema}.${safeTable} SET ${updates} WHERE ${quoteId(pkColumn)} = $${pkValIndex} RETURNING *`, [...values, pkValue], 'updRowsSingle');
            });
            // --- CASCATA PRIVACY ENGINE (Centralized) ---
            const maskedRows = await DataController.applyMaskingTier(req, result.rows, req.params.tableName);
            res.json(maskedRows);
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

            const pkRes = await r.projectPool!.query(pkQuery, [schema, tableName]);

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
                return await client.query(`DELETE FROM ${safeSchema}.${safeTable} WHERE ${quoteId(realPkColumn)} = ANY($1) RETURNING *`, [ids], 'delRowsMulti');
            });
            // --- CASCATA PRIVACY ENGINE (Centralized) ---
            const maskedRows = await DataController.applyMaskingTier(req, result.rows, req.params.tableName);
            res.json(maskedRows);
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
                const result = await client.query(`SELECT * FROM ${safeSchema}.${quoteId(req.params.name)}(${namedPlaceholders})`, values, `rpc_${req.params.name}`);
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
            const result = await r.projectPool!.query(`
                SELECT DISTINCT routine_name as name 
                FROM information_schema.routines 
                WHERE routine_schema = $1 
                  AND routine_name NOT LIKE 'uuid_%' 
                  AND routine_name NOT LIKE 'pgp_%'
            `, [schema]);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async listTriggers(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled.' });
        }
        try {
            const schema = req.query.schema || 'public';
            const result = await r.projectPool!.query(`
                SELECT DISTINCT trigger_name as name 
                FROM information_schema.triggers 
                WHERE trigger_schema = $1
            `, [schema]);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async getFunctionDefinition(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled.' });
        }
        try {
            const schema = req.query.schema || 'public';
            const defResult = await r.projectPool!.query("SELECT pg_get_functiondef(p.oid) as def FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = $1 AND n.nspname = $2", [req.params.name, schema]);
            const argsResult = await r.projectPool!.query(`SELECT parameter_name as name, data_type as type, parameter_mode as mode FROM information_schema.parameters WHERE specific_name = (SELECT specific_name FROM information_schema.routines WHERE routine_name = $1 AND routine_schema = $2 LIMIT 1) ORDER BY ordinal_position ASC`, [req.params.name, schema]);
            if (defResult.rows.length === 0) return res.status(404).json({ error: 'Function not found' });
            res.json({ definition: defResult.rows[0].def, args: argsResult.rows });
        } catch (e: any) { next(e); }
    }

    static async getTriggerDefinition(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled.' });
        }
        try {
            const schema = req.query.schema || 'public';
            // Trigger definitions are per-table, but here we look by name in the schema.
            // Using pg_trigger joined with pg_class and pg_namespace for schema awareness.
            const result = await r.projectPool!.query(`
                SELECT pg_get_triggerdef(t.oid) as def 
                FROM pg_trigger t
                JOIN pg_class c ON t.tgrelid = c.oid
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE t.tgname = $1 AND n.nspname = $2
                LIMIT 1
            `, [req.params.name, schema]);

            if (result.rows.length === 0) return res.status(404).json({ error: 'Trigger not found' });
            res.json({ definition: result.rows[0].def });
        } catch (e: any) { next(e); }
    }

    // --- SCHEMA & METADATA ---

    static async getColumns(req: CascataRequest, res: any, next: any) {
        if (!DataController.checkSchemaAccess(req)) {
            return res.status(403).json({ error: 'Schema access disabled.' });
        }
        try {
            const schema = req.query.schema || 'public';
            const result = await r.projectPool!.query(
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

            // TIER-3 UNIVERSAL PADLOCK (Frontend Propagation)
            const globalLocks = r.project.metadata?.locked_columns || {};
            const tableLocks = globalLocks[req.params.tableName] || {};

            const globalMasks = r.project.metadata?.masked_columns || {};
            const tableMasks = globalMasks[req.params.tableName] || {};

            // Parse format patterns from comments
            const enriched = result.rows.map((row: any) => {
                const parsed = parseColumnFormat(row.rawComment);
                return {
                    ...row,
                    description: parsed.description || '',
                    formatPattern: parsed.formatPattern || null,
                    lockLevel: tableLocks[row.name] || 'unlocked', // Expose the padlock tier statically
                    maskLevel: tableMasks[row.name] || 'unmasked', // Expose masking tier
                    rawComment: undefined // Don't expose raw comment to client
                };
            });

            res.json(enriched);
        } catch (e: any) { next(e); }
    }

    static async runRawQuery(req: CascataRequest, res: any, next: any) {
        if (r.userRole !== 'service_role') { res.status(403).json({ error: 'Only Service Role can execute raw SQL' }); return; }
        try {
            const start = Date.now();
            const client = await r.projectPool!.connect();
            try {
                await client.query("SET LOCAL statement_timeout = '60s'");

                // SECURITY FIX: Support parameterized queries for safe backend execution
                const sql = req.body.sql;
                const params = req.body.params || [];
                const result = await client.query(sql, params);

                // Auto-grant: After DDL, ensure cascata_api_role can access all user schemas
                const cmd = (result.command || '').toUpperCase();
                if (['CREATE', 'ALTER', 'DROP'].includes(cmd)) {
                    // CASCATA HYBRID REFRESH: Force Pool Service to eject all connections for this tenant
                    // This is the nuclear option to prevent "cached plan" errors after schema changes.
                    try {
                        const PoolSvc = (await import('../../services/PoolService.js')).PoolService;
                        await PoolSvc.reload(r.project.slug);
                    } catch (poolErr) {
                        console.warn('[runRawQuery] Pool reload failed:', poolErr);
                    }

                    try {
                        await client.query(`
                            DO $$ 
                            DECLARE s TEXT; t TEXT; 
                            BEGIN
                                FOR s IN SELECT schema_name FROM information_schema.schemata
                                    WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
                                    AND schema_name NOT LIKE 'pg_temp_%'
                                    AND schema_name NOT LIKE 'pg_toast_temp_%'
                                LOOP
                                    -- 1. Infrastructure Layer (Always Open to System/Service)
                                    EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role, cascata_api_role', s);
                                    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO service_role, cascata_api_role', s);
                                    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO service_role, cascata_api_role', s);
                                    
                                    -- 2. Data Access Layer (Conditional/Managed)
                                    -- We grant basic DML to public roles so RLS can then filter them.
                                    -- Without these, RLS policies wouldn't even be evaluated.
                                    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO anon, authenticated', s);
                                    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO anon, authenticated', s);
                                    
                                    -- Hardening: Ensure No "Owner-Bypass" paths are left open for public roles
                                    -- (Already handled by FORCE RLS below, but being explicit)
                                    
                                    -- 3. RLS Atomic Blindagem (Row Level Protection)
                                    -- We only force RLS if the table ALREADY has it enabled by the user.
                                    -- This respects the "Disabled - Open Access" state during construction.
                                    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = s LOOP
                                        -- Check current RLS status
                                        DECLARE
                                            is_rls_active BOOLEAN;
                                        BEGIN
                                            SELECT relrowsecurity INTO is_rls_active FROM pg_class 
                                            JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace 
                                            WHERE nspname = s AND relname = t;

                                            IF is_rls_active THEN
                                                EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', s, t);
                                                
                                                -- System Identity Bypass: Ensures Dashboard/Backend are never locked out
                                                IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = s AND tablename = t AND policyname = 'master_system_policy') THEN
                                                    EXECUTE format('CREATE POLICY master_system_policy ON %I.%I FOR ALL TO service_role, current_user USING (true) WITH CHECK (true)', s, t);
                                                END IF;
                                            END IF;
                                        END;
                                    END LOOP;
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
        if (!r.isSystemRequest) { res.status(403).json({ error: 'Only Dashboard can create tables.' }); return; }
        const { name, columns, description } = req.body;
        const schema = req.query.schema || 'public';
        const safeSchema = quoteId(schema as string);
        try {
            if (r.projectPool) await DatabaseService.validateTableDefinition(r.projectPool, name, columns);
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

            // Execute the schema creation
            await r.projectPool!.query(sql);

            // Optional RLS Enforcement (True by default, but user can opt-out for construction)
            const rlsEnabled = req.body.rls_enabled !== false;

            if (rlsEnabled) {
                await r.projectPool!.query(`ALTER TABLE ${safeSchema}.${safeName} ENABLE ROW LEVEL SECURITY`);
                await r.projectPool!.query(`ALTER TABLE ${safeSchema}.${safeName} FORCE ROW LEVEL SECURITY`);

                // Security Blindagem: Create Master Policy for Service Role and Owner (God Mode)
                const tblName = String(name);
                const schName = String(schema);
                await r.projectPool!.query(`
                    DO $$ BEGIN
                        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = ${quotePostgresLiteral(schName)} AND tablename = ${quotePostgresLiteral(tblName)} AND policyname = 'master_system_policy') THEN
                            EXECUTE format('CREATE POLICY master_system_policy ON %I.%I FOR ALL TO service_role, current_user USING (true) WITH CHECK (true)', ${quotePostgresLiteral(schName)}, ${quotePostgresLiteral(tblName)});
                        END IF;
                    END $$;
                `);
            }

            // 1. Core Event Webhook Trigger
            await r.projectPool!.query(`CREATE TRIGGER ${name}_changes AFTER INSERT OR UPDATE OR DELETE ON ${safeSchema}.${safeName} FOR EACH ROW EXECUTE FUNCTION public.notify_changes();`);

            // 2. TIER-3 UNIVERSAL PADLOCK (Auto-Injection for Temporal Columns)
            // As per Commander's directive: created_at and updated_at get the Database 'Iron-Clad' Trigger automatically.
            const hasCreatedAt = columns.some((c: any) => c.name === 'created_at');
            const hasUpdatedAt = columns.some((c: any) => c.name === 'updated_at');

            if (hasCreatedAt || hasUpdatedAt) {
                // Determine which fields to freeze on update and which to strictly override with now()
                const lockStatements = [];
                if (hasCreatedAt) lockStatements.push('NEW.created_at = OLD.created_at;');
                if (hasUpdatedAt) lockStatements.push('NEW.updated_at = now();'); // Force updated_at strictly to server time

                const triggerFuncName = `lock_temporal_state_${name}`;
                const triggerSql = `
                    CREATE OR REPLACE FUNCTION ${safeSchema}.${quoteId(triggerFuncName)}()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        ${lockStatements.join('\n                        ')}
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;

                    CREATE TRIGGER ensure_temporal_integrity_${name}
                    BEFORE UPDATE ON ${safeSchema}.${safeName}
                    FOR EACH ROW EXECUTE FUNCTION ${safeSchema}.${quoteId(triggerFuncName)}();
                `;
                await r.projectPool!.query(triggerSql);
            }

            if (description) await r.projectPool!.query(`COMMENT ON TABLE ${safeSchema}.${safeName} IS $1`, [description]);

            // SECURITY HYBRID FLUSH: Ensure new table structure is recognized immediately
            try {
                const PoolSvc = (await import('../../services/PoolService.js')).PoolService;
                await PoolSvc.reload(r.project.slug);
            } catch (e) { }

            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    // --- RECYCLE BIN & SOFT DELETE ---

    static async deleteTable(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) { res.status(403).json({ error: 'Only Dashboard can delete tables.' }); return; }
        const { mode } = req.body;
        const schema = req.query.schema || 'public';
        const safeSchema = quoteId(schema as string);
        try {
            if (mode === 'CASCADE' || mode === 'RESTRICT') {
                const cascadeSql = mode === 'CASCADE' ? 'CASCADE' : '';
                await r.projectPool!.query(`DROP TABLE ${safeSchema}.${quoteId(req.params.table)} ${cascadeSql}`);
            } else {
                const deletedName = `_deleted_${Date.now()}_${req.params.table}`;
                await r.projectPool!.query(`ALTER TABLE ${safeSchema}.${quoteId(req.params.table)} RENAME TO ${quoteId(deletedName)}`);
            }

            // Pool Refresh to clear cached plans of the modified table
            try {
                const PoolSvc = (await import('../../services/PoolService.js')).PoolService;
                await PoolSvc.reload(r.project.slug);
            } catch (e) { }

            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async listRecycleBin(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
        try {
            const schema = req.query.schema || 'public';
            const result = await r.projectPool!.query("SELECT table_name as name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '\\_deleted\\_%'", [schema]);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async restoreTable(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
        try {
            const schema = req.query.schema || 'public';
            const safeSchema = quoteId(schema as string);
            const originalName = req.params.table.replace(/^_deleted_\d+_/, '');
            await r.projectPool!.query(`ALTER TABLE ${safeSchema}.${quoteId(req.params.table)} RENAME TO ${quoteId(originalName)}`);

            try {
                const PoolSvc = (await import('../../services/PoolService.js')).PoolService;
                await PoolSvc.reload(r.project.slug);
            } catch (e) { }

            res.json({ success: true, restoredName: originalName });
        } catch (e: any) { next(e); }
    }

    // --- SYSTEM ASSETS & SETTINGS (GLOBAL via systemPool) ---

    static async getUiSettings(req: CascataRequest, res: any, next: any) {
        try {
            const { slug, table } = req.params;
            const result = await systemPool.query(
                'SELECT settings FROM system.ui_settings WHERE project_slug = $1 AND table_name = $2',
                [slug, table]
            );
            res.json(result.rows[0]?.settings || {});
        } catch (e: any) {
            next(e);
        }
    }

    static async saveUiSettings(req: CascataRequest, res: any, next: any) {
        try {
            const { slug, table } = req.params;
            const { settings } = req.body;

            await systemPool.query(
                `INSERT INTO system.ui_settings (project_slug, table_name, settings) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $3`,
                [slug, table, JSON.stringify(settings || {})]
            );
            res.json({ success: true });
        } catch (e: any) {
            next(e);
        }
    }

    static async getAssets(req: CascataRequest, res: any, next: any) {
        try {
            // Guarantee tenant isolation by accessing project.slug from verified JWT payload
            const result = await systemPool.query(
                `SELECT id, project_slug, name, type, parent_id, metadata, created_at, updated_at 
                 FROM system.assets 
                 WHERE project_slug = $1 
                 ORDER BY created_at DESC`,
                [r.project.slug]
            );
            res.json(result.rows);
        } catch (e: any) {
            next(e);
        }
    }
    static async upsertAsset(req: CascataRequest, res: any, next: any) {
        const { id, name, type, parent_id, metadata } = req.body;
        try {
            let assetId = id;
            const safeParentId = (parent_id === 'root' || parent_id === '') ? null : parent_id;
            if (id) {
                // CRITICAL FIX: Ensure the asset being updated belongs to the current project
                const checkRes = await systemPool.query('SELECT 1 FROM system.assets WHERE id = $1 AND project_slug = $2', [id, r.project.slug]);
                if (checkRes.rowCount === 0) return res.status(404).json({ error: 'Asset not found or unauthorized' });

                let query = 'UPDATE system.assets SET name=$1, metadata=$2 WHERE id=$3 AND project_slug=$4 RETURNING *';
                let params = [name, metadata, id, r.project.slug];
                if (parent_id !== undefined) {
                    query = 'UPDATE system.assets SET name=$1, metadata=$2, parent_id=$5 WHERE id=$3 AND project_slug=$4 RETURNING *';
                    params = [name, metadata, id, r.project.slug, safeParentId];
                }
                const upd = await systemPool.query(query, params);
                assetId = upd.rows[0].id;
                res.json(upd.rows[0]);
            } else {
                const ins = await systemPool.query('INSERT INTO system.assets (project_slug, name, type, parent_id, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *', [r.project.slug, name, type, safeParentId, metadata]);
                assetId = ins.rows[0].id;
                res.json(ins.rows[0]);
            }
            if (metadata?.sql) systemPool.query('INSERT INTO system.asset_history (asset_id, project_slug, content, metadata, created_by) VALUES ($1, $2, $3, $4, $5)', [assetId, r.project.slug, metadata.sql, metadata, r.userRole]);
        } catch (e: any) { next(e); }
    }
    static async deleteAsset(req: CascataRequest, res: any, next: any) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return res.json({ success: true });
        try {
            // CRITICAL FIX: Ensure the asset being deleted belongs to the current project
            await systemPool.query('DELETE FROM system.assets WHERE id=$1 AND project_slug=$2', [req.params.id, r.project.slug]);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    // --- CASCATA AUTOMATIONS (MANAGEMENT) ---

    static async listAutomations(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        try {
            const result = await systemPool.query(
                `SELECT id, name, description, trigger_type, trigger_config, nodes, is_active, created_at, updated_at 
                 FROM system.automations 
                 WHERE project_slug = $1 
                 ORDER BY created_at DESC`,
                [r.project.slug]
            );
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async upsertAutomation(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { id, name, description, trigger_type, trigger_config, nodes, is_active } = req.body;
        try {
            if (id) {
                // Update
                const result = await systemPool.query(
                    `UPDATE system.automations 
                     SET name = $1, description = $2, trigger_type = $3, trigger_config = $4, nodes = $5, is_active = $6, updated_at = NOW()
                     WHERE id = $7 AND project_slug = $8
                     RETURNING *`,
                    [
                        name,
                        description,
                        trigger_type,
                        typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config || {}),
                        typeof nodes === 'string' ? nodes : JSON.stringify(nodes || []),
                        is_active ?? true,
                        id,
                        r.project.slug
                    ]
                );
                if (result.rowCount === 0) return res.status(404).json({ error: 'Automation not found.' });
                AutomationService.invalidateCache(r.project.slug);

                // CRON SYNC: Ensure repeatable jobs are updated
                await CronService.unregisterAutomation(id);
                if ((is_active ?? true) && trigger_type === 'CRON') {
                    await CronService.registerAutomation(result.rows[0]);
                }

                res.json(result.rows[0]);
            } else {
                // Insert
                const result = await systemPool.query(
                    `INSERT INTO system.automations (project_slug, name, description, trigger_type, trigger_config, nodes, is_active)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     RETURNING *`,
                    [
                        r.project.slug,
                        name,
                        description,
                        trigger_type,
                        typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config || {}),
                        typeof nodes === 'string' ? nodes : JSON.stringify(nodes || []),
                        is_active ?? true
                    ]
                );
                AutomationService.invalidateCache(r.project.slug);

                // CRON SYNC: Register if scheduled
                if ((is_active ?? true) && trigger_type === 'CRON') {
                    await CronService.registerAutomation(result.rows[0]);
                }

                res.json(result.rows[0]);
            }
        } catch (e: any) { next(e); }
    }

    static async deleteAutomation(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        try {
            await CronService.unregisterAutomation(req.params.id);
            const result = await systemPool.query(
                'DELETE FROM system.automations WHERE id = $1 AND project_slug = $2',
                [req.params.id, r.project.slug]
            );
            AutomationService.invalidateCache(r.project.slug);
            res.json({ success: true });
        } catch (e: any) { next(e); }
    }

    static async listAutomationRuns(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        const { automation_id } = req.query;
        try {
            let query = `SELECT id, automation_id, status, execution_time_ms, trigger_payload, final_output, error_message, created_at 
                         FROM system.automation_runs 
                         WHERE project_slug = $1`;
            const params = [r.project.slug];

            if (automation_id) {
                query += ` AND automation_id = $2`;
                params.push(automation_id as string);
            }

            query += ` ORDER BY created_at DESC LIMIT 100`;

            const result = await systemPool.query(query, params);
            res.json(result.rows);
        } catch (e: any) { next(e); }
    }

    static async getAutomationStats(req: CascataRequest, res: any, next: any) {
        if (!r.isSystemRequest) return res.status(403).json({ error: 'Unauthorized' });
        try {
            // One aggregation query per project — joins automation_runs grouped by automation_id.
            // LEFT JOIN ensures automations with zero runs still appear (with 0 counts).
            const result = await systemPool.query(
                `SELECT
                    a.id                                                        AS automation_id,
                    COUNT(r.id)::int                                            AS total_runs,
                    COUNT(r.id) FILTER (WHERE r.status = 'success')::int        AS success_count,
                    COUNT(r.id) FILTER (WHERE r.status = 'failed')::int         AS failed_count,
                    ROUND(AVG(r.execution_time_ms))::int                        AS avg_ms,
                    MAX(r.created_at)                                           AS last_run_at
                 FROM system.automations a
                 LEFT JOIN system.automation_runs r
                   ON r.automation_id = a.id AND r.project_slug = a.project_slug
                 WHERE a.project_slug = $1
                 GROUP BY a.id`,
                [r.project.slug]
            );
            // Return as a map { [automation_id]: stats } for O(1) lookup in the frontend
            const statsMap: Record<string, any> = {};
            for (const row of result.rows) {
                statsMap[row.automation_id] = {
                    total_runs: row.total_runs,
                    success_count: row.success_count,
                    failed_count: row.failed_count,
                    avg_ms: row.avg_ms ?? 0,
                    last_run_at: row.last_run_at
                };
            }
            res.json(statsMap);
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
                [req.params.id, r.project.slug]
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
            `, [r.project.slug]);

            const client = await r.projectPool!.connect();
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
                    throughput: logsRes.rows.map((r: any) => ({
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
            // TIER-3 UNIVERSAL PADLOCK (Gateway Extraction & Injection)
            // Extract the locked columns metadata configured via the Frontend Table Builder
            const lockedColumns = r.project.metadata?.locked_columns;
            if (lockedColumns) {
                req.headers['x-cascata-locked-columns'] = JSON.stringify(lockedColumns);
                req.headers['x-cascata-role'] = r.userRole;
                req.headers['x-cascata-project-id'] = r.project.id;
                req.headers['x-cascata-jwt-secret'] = r.project.jwt_secret;
            }
            const maskedColumns = r.project.metadata?.masked_columns;
            if (maskedColumns) {
                req.headers['x-cascata-masked-columns'] = JSON.stringify(maskedColumns);
            }

            const buildResult = PostgrestService.buildQuery(
                req.params.tableName,
                req.method,
                req.query,
                req.body,
                req.headers
            );

            // --- DRAGONFLY SEMANTIC CACHE INTERCEPTOR (Fase 1.3) ---
            // Bypass completo de Banco de Dados se a Query já foi resolvida e está viva na RAM Multi-Thread.
            const dfly = (RateLimitService as any).dragonfly;
            let fromCache = false;

            if (buildResult.cacheKey && req.method === 'GET' && dfly && (RateLimitService as any).isDragonflyHealthy) {
                try {
                    const cachedData = await dfly.get(buildResult.cacheKey);
                    if (cachedData) {
                        res.setHeader('X-Cascata-Cache', 'HIT');
                        res.setHeader('Content-Type', 'application/json');
                        return res.send(cachedData); // Retorna a string JSON crua do Dragonfly (Extrema Velocidade)
                    }
                } catch (ce) {
                    console.warn('[Cache] Semantic Bypass falhou, caindo pro banco:', ce);
                }
            }

            const result = await queryWithRLS(req, async (client) => {
                if (buildResult.countQuery) {
                    await client.query("SET LOCAL statement_timeout = '5s'");
                    const countRes = await client.query(buildResult.countQuery, buildResult.values, buildResult.name ? buildResult.name + '_cnt' : undefined);
                    const total = parseInt((countRes.rows[0] as any)?.total || '0');
                    const mainRes = await client.query(buildResult.text, buildResult.values, buildResult.name);
                    const offset = parseInt(req.query.offset as string || '0');
                    const start = offset;
                    const end = Math.min(offset + mainRes.rows.length - 1, total - 1);
                    res.setHeader('Content-Range', mainRes.rows.length === 0 ? `*/${total}` : `${start}-${end}/${total}`);
                    return mainRes;
                }
                return await client.query(buildResult.text, buildResult.values, buildResult.name);
            });

            let responseData = req.headers.accept === 'application/vnd.pgrst.object+json'
                ? (result.rows[0] || null)
                : result.rows;

            // --- CASCATA AUTOMATIONS: LOGIC INTERCEPTOR ---
            // Allows the user to hijack and transform the API response via a No-Code workflow
            if (responseData && !fromCache) {
                responseData = await AutomationService.interceptResponse(
                    r.project.slug,
                    req.params.tableName,
                    req.method as any,
                    responseData,
                    {
                        vars: {},
                        payload: responseData,
                        projectSlug: r.project.slug,
                        jwtSecret: r.project.jwt_secret,
                        projectPool: r.projectPool!,
                        // --- SECURITY: Pass the caller's identity so SQL nodes
                        //     can enforce RLS with the correct role and claims. ---
                        userRole: r.userRole,
                        jwtClaims: {
                            sub: req.user?.sub,
                            email: req.user?.email,
                            role: r.userRole,
                            identifier: (req.user as any)?.identifier,
                            provider: (req.user as any)?.provider,
                        }
                    }
                );
            }

            // --- CASCATA PRIVACY ENGINE (Centralized Synergy) ---
            if (req.method === 'GET') {
                responseData = await DataController.applyMaskingTier(req, responseData, req.params.tableName);
            }

            // Finally, render the (potentially modified/masked) response
            // FIX: Set cache header BEFORE sending response body — headers cannot be set after res.json()
            if (buildResult.cacheKey && !fromCache) {
                res.setHeader('X-Cascata-Cache', 'MISS');
            }
            res.json(responseData);

            // Fire-And-Forget: Escreve no Dragonfly pós-resposta para não bloquear o Event Loop do client atual
            if (buildResult.cacheKey && !fromCache && dfly && (RateLimitService as any).isDragonflyHealthy) {
                // A key expira sozinha pelo TTL exigido
                dfly.set(buildResult.cacheKey, JSON.stringify(responseData), 'EX', buildResult.ttl || 60).catch(() => { });
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
