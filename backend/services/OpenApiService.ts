import { Pool } from 'pg';

export class OpenApiService {
    
    public static async generate(projectSlug: string, dbName: string, projectPool: Pool, host: string) {
        const tables = await this.getTables(projectPool);
        
        const paths: any = {};
        const schemas: any = {};

        for (const table of tables) {
            const columns = await this.getColumns(projectPool, table);
            const schemaName = table;
            
            // Define Schema
            schemas[schemaName] = {
                type: 'object',
                properties: columns.reduce((acc: any, col: any) => {
                    acc[col.name] = {
                        type: this.mapPgTypeToOpenApi(col.type),
                        description: col.is_nullable === 'YES' ? 'Nullable' : 'Required'
                    };
                    return acc;
                }, {})
            };

            // Define Paths (CRUD)
            paths[`/tables/${table}/data`] = {
                get: {
                    summary: `List ${table}`,
                    tags: [table],
                    parameters: [
                        { name: 'select', in: 'query', schema: { type: 'string' }, description: 'Columns to select' },
                        { name: 'limit', in: 'query', schema: { type: 'integer' } },
                        { name: 'offset', in: 'query', schema: { type: 'integer' } }
                    ],
                    responses: {
                        '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: `#/components/schemas/${schemaName}` } } } } }
                    }
                }
            };

            paths[`/tables/${table}/rows`] = {
                post: {
                    summary: `Create ${table}`,
                    tags: [table],
                    requestBody: {
                        content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: `#/components/schemas/${schemaName}` } } } } }
                    },
                    responses: { '201': { description: 'Created' } }
                },
                put: {
                    summary: `Update ${table}`,
                    tags: [table],
                    requestBody: {
                        content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object' }, pkColumn: {type: 'string'}, pkValue: {type: 'string'} } } } }
                    },
                    responses: { '200': { description: 'Updated' } }
                },
                delete: {
                    summary: `Delete ${table}`,
                    tags: [table],
                    requestBody: {
                        content: { 'application/json': { schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, pkColumn: {type: 'string'} } } } }
                    },
                    responses: { '200': { description: 'Deleted' } }
                }
            };
        }

        return {
            openapi: '3.0.0',
            info: {
                title: `${projectSlug} API`,
                version: '1.0.0',
                description: 'Auto-generated API via Cascata Engine.'
            },
            servers: [{ url: host.includes('localhost') ? `http://${host}/api/data/${projectSlug}` : `https://${host}` }],
            paths,
            components: {
                schemas,
                securitySchemes: {
                    ApiKeyAuth: {
                        type: 'apiKey',
                        in: 'header',
                        name: 'apikey'
                    },
                    BearerAuth: {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT'
                    }
                }
            },
            security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }]
        };
    }

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

    private static async getColumns(pool: Pool, table: string) {
        const res = await pool.query(`
            SELECT column_name as name, data_type as type, is_nullable
            FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name = $1
        `, [table]);
        return res.rows;
    }

    private static mapPgTypeToOpenApi(pgType: string) {
        if (['integer', 'bigint', 'smallint', 'numeric'].includes(pgType)) return 'integer';
        if (['boolean'].includes(pgType)) return 'boolean';
        if (['json', 'jsonb'].includes(pgType)) return 'object';
        return 'string';
    }
}