
import { Pool } from 'pg';
import { URL } from 'url';

export class OpenApiService {
    
    /**
     * Generates standard OpenAPI spec for Cascata Native API (Internal Dashboard)
     */
    public static async generate(projectSlug: string, dbName: string, projectPool: Pool, systemPool: Pool, baseUrl: string) {
        return this.buildNativeSpec(projectSlug, projectPool, systemPool, baseUrl);
    }

    /**
     * Generates PostgREST-compatible Swagger 2.0 spec for FlutterFlow
     * Now includes Edge Functions as POST endpoints.
     */
    public static async generatePostgrest(projectSlug: string, dbName: string, projectPool: Pool, systemPool: Pool, baseUrl: string) {
        return this.buildSwagger2Spec(projectSlug, projectPool, systemPool, baseUrl);
    }

    // --- SWAGGER 2.0 BUILDER (PostgREST/Supabase Clone) ---
    private static async buildSwagger2Spec(projectSlug: string, pool: Pool, systemPool: Pool, baseUrl: string) {
        const tables = await this.getTables(pool);
        const edgeFunctions = await this.getEdgeFunctions(projectSlug, systemPool);
        
        let hostStr = 'localhost';
        let basePathStr = '/';
        let schemesList = ['http'];

        try {
            const urlToParse = baseUrl.startsWith('http') ? baseUrl : `http://${baseUrl}`;
            const parsed = new URL(urlToParse);
            hostStr = parsed.host;
            basePathStr = parsed.pathname;
            schemesList = [parsed.protocol.replace(':', '')];
            if (basePathStr.endsWith('/') && basePathStr.length > 1) {
                basePathStr = basePathStr.slice(0, -1);
            }
        } catch (e) { console.warn('[OpenAPI] Failed to parse baseUrl'); }

        const spec: any = {
            swagger: "2.0",
            info: {
                description: "Standard public schema API & Edge Functions",
                title: "Cascata API",
                version: "12.0.2"
            },
            host: hostStr,
            basePath: basePathStr,
            schemes: schemesList,
            consumes: ["application/json", "application/vnd.pgrst.object+json"],
            produces: ["application/json", "application/vnd.pgrst.object+json", "text/csv"],
            paths: {
                "/": {
                    get: {
                        produces: ["application/openapi+json", "application/json"],
                        responses: { "200": { description: "OK" } },
                        summary: "OpenAPI description",
                        tags: ["Introspection"]
                    }
                }
            },
            definitions: {},
            parameters: {
                select: { name: "select", description: "Filtering Columns", required: false, in: "query", type: "string" },
                order: { name: "order", description: "Ordering", required: false, in: "query", type: "string" },
                limit: { name: "limit", description: "Limiting and Pagination", required: false, in: "query", type: "integer" },
                offset: { name: "offset", description: "Limiting and Pagination", required: false, in: "query", type: "integer" },
                preferPost: { name: "Prefer", description: "Preference", required: false, in: "header", type: "string", enum: ["return=representation", "return=minimal"] }
            }
        };

        // 1. Build Table Definitions
        for (const table of tables) {
            const columns = await this.getColumns(pool, table);
            const properties: any = {};
            const required: string[] = [];

            columns.forEach((col: any) => {
                const typeMap = this.mapPgTypeToSwagger(col);
                properties[col.name] = {
                    type: typeMap.type,
                    format: typeMap.format,
                    description: this.buildDescription(col)
                };
                if (col.column_default !== null) properties[col.name].default = col.column_default;
                if (col.is_primary_key || (col.is_nullable === 'NO' && !col.column_default)) required.push(col.name);
                
                // Row Filters
                spec.parameters[`rowFilter.${table}.${col.name}`] = {
                    name: col.name,
                    required: false,
                    in: "query",
                    type: "string",
                    description: `Filter ${table} by ${col.name}`
                };
            });

            spec.definitions[table] = { type: "object", properties, required: required.length > 0 ? required : undefined };

            // Body Param
            spec.parameters[`body.${table}`] = {
                name: table, description: table, required: false, in: "body", schema: { $ref: `#/definitions/${table}` }
            };

            const rowFilters = columns.map((c: any) => ({ $ref: `#/parameters/rowFilter.${table}.${c.name}` }));

            spec.paths[`/${table}`] = {
                get: {
                    tags: [table],
                    parameters: [...rowFilters, { $ref: "#/parameters/select" }, { $ref: "#/parameters/order" }, { $ref: "#/parameters/limit" }, { $ref: "#/parameters/offset" }],
                    responses: { "200": { description: "OK", schema: { type: "array", items: { $ref: `#/definitions/${table}` } } } }
                },
                post: {
                    tags: [table],
                    parameters: [{ $ref: `#/parameters/body.${table}` }, { $ref: "#/parameters/preferPost" }],
                    responses: { "201": { description: "Created" } }
                },
                patch: {
                    tags: [table],
                    parameters: [...rowFilters, { $ref: `#/parameters/body.${table}` }],
                    responses: { "204": { description: "Updated" } }
                },
                delete: {
                    tags: [table],
                    parameters: [...rowFilters],
                    responses: { "204": { description: "Deleted" } }
                }
            };
        }

        // 2. Build Edge Functions Paths
        // In Swagger 2.0/PostgREST mode, we might map them to /rpc/name or separate path if gateway supports it.
        // For standard PostgREST clients, everything is usually /rpc. But Edge is separate.
        // We will list them under "Edge Functions" tag.
        
        // IMPORTANT: Since baseUrl usually ends in /rest/v1 for PostgREST, 
        // Edge functions live at /api/data/:slug/edge/:name.
        // If the client uses the Swagger BaseURL, they might not reach Edge unless we use absolute paths or a proxy.
        // Assuming the Gateway routes /edge correctly relative to root, we document them here as relative paths 
        // but note the prefix difference if needed. 
        // Ideally, for FlutterFlow, we should expose them under the same BasePath if possible, or use a workaround.
        // Current Router: /api/data/:slug/rest/v1/... (PostgREST) AND /api/data/:slug/edge/...
        // We will document them as `../edge/{name}` hack or assume Unified Gateway.
        
        for (const fn of edgeFunctions) {
            // Note: We use a trick for Swagger UI to show them, but integration might need manual URL adjustment
            // depending on the tool.
            spec.paths[`/edge/${fn.name}`] = {
                post: {
                    tags: ["Edge Functions"],
                    summary: `Execute ${fn.name}`,
                    description: fn.metadata?.notes || "Serverless Function",
                    consumes: ["application/json"],
                    produces: ["application/json"],
                    parameters: [
                        {
                            name: "payload",
                            in: "body",
                            required: false,
                            schema: {
                                type: "object",
                                example: { key: "value" }
                            }
                        }
                    ],
                    responses: {
                        "200": {
                            description: "Successful Execution",
                            schema: { type: "object" }
                        }
                    }
                }
            };
        }

        return spec;
    }

    // --- OPENAPI 3.0 BUILDER (Native Dashboard) ---
    private static async buildNativeSpec(projectSlug: string, pool: Pool, systemPool: Pool, baseUrl: string) {
        const tables = await this.getTables(pool);
        const edgeFunctions = await this.getEdgeFunctions(projectSlug, systemPool);
        
        const paths: any = {};
        const schemas: any = {};

        for (const table of tables) {
            const columns = await this.getColumns(pool, table);
            schemas[table] = {
                type: 'object',
                properties: columns.reduce((acc: any, col: any) => {
                    const typeDef = this.mapPgTypeToSwagger(col);
                    acc[col.name] = { type: typeDef.type, format: typeDef.format };
                    return acc;
                }, {})
            };
            paths[`/tables/${table}/data`] = {
                get: {
                    summary: `List ${table}`,
                    tags: [table],
                    responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: `#/components/schemas/${table}` } } } } } }
                }
            };
        }

        // Add Edge Functions
        for (const fn of edgeFunctions) {
            paths[`/edge/${fn.name}`] = {
                post: {
                    summary: `Invoke ${fn.name}`,
                    tags: ['Edge Functions'],
                    requestBody: {
                        content: { 'application/json': { schema: { type: 'object', example: { foo: 'bar' } } } }
                    },
                    responses: { '200': { description: 'OK' } }
                }
            };
        }

        return {
            openapi: '3.0.0',
            info: { title: `${projectSlug} API`, version: '1.0.0' },
            servers: [{ url: baseUrl }],
            paths,
            components: { schemas }
        };
    }

    // --- HELPERS ---

    private static async getTables(pool: Pool) {
        const res = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
            AND table_name NOT LIKE '_deleted_%'
        `);
        return res.rows.map(r => r.table_name);
    }

    private static async getEdgeFunctions(slug: string, systemPool: Pool) {
        try {
            const res = await systemPool.query(
                "SELECT name, metadata FROM system.assets WHERE project_slug = $1 AND type = 'edge_function'", 
                [slug]
            );
            return res.rows;
        } catch (e) { return []; }
    }

    private static async getColumns(pool: Pool, table: string) {
        const res = await pool.query(`
            SELECT 
                a.attname as name,
                t.typname as udt_name,
                CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END as is_nullable,
                pg_get_expr(d.adbin, d.adrelid) as column_default,
                COALESCE(i.indisprimary, false) as is_primary_key
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_type t ON a.atttypid = t.oid
            LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
            LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
            WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
        `, [table]);
        return res.rows;
    }

    private static buildDescription(col: any): string {
        let desc = '';
        if (col.is_primary_key) desc = 'Note:\nThis is a Primary Key.<pk/>';
        return desc;
    }

    private static mapPgTypeToSwagger(col: any): { type: string, format: string, items?: any } {
        const udt = col.udt_name.toLowerCase(); 
        if (['int2', 'smallint'].includes(udt)) return { type: 'integer', format: 'smallint' };
        if (['int4', 'integer', 'serial', 'serial4'].includes(udt)) return { type: 'integer', format: 'integer' }; 
        if (['int8', 'bigint', 'bigserial', 'serial8'].includes(udt)) return { type: 'integer', format: 'bigint' };
        if (['numeric', 'decimal', 'real', 'float4', 'double precision', 'float8', 'money'].includes(udt)) return { type: 'number', format: 'numeric' };
        if (['bool', 'boolean'].includes(udt)) return { type: 'boolean', format: 'boolean' };
        if (udt === 'uuid') return { type: 'string', format: 'uuid' };
        if (['json', 'jsonb'].includes(udt)) return { type: 'object', format: 'json' };
        if (udt.startsWith('_')) {
            const innerUdt = udt.substring(1);
            const innerMap = this.mapPgTypeToSwagger({ udt_name: innerUdt });
            return { type: 'array', format: udt, items: { type: innerMap.type, format: innerMap.format } };
        }
        return { type: 'string', format: 'text' };
    }
}
