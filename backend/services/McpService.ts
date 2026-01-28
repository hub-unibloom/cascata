
import { Pool } from 'pg';
import axios from 'axios';
import { systemPool } from '../src/config/main.js';
import { WebhookService } from './WebhookService.js';

export class McpService {
    
    /**
     * Gera o contexto arquitetural Completo:
     * 1. Schema do Banco (Tabelas e Relações)
     * 2. Lógica de Negócio (Edge Functions disponíveis)
     * 
     * FILTRADO pela configuração de Governança
     */
    public static async getSchemaContext(pool: Pool, projectSlug: string, governance: any): Promise<string> {
        const client = await pool.connect();
        try {
            const allowedTables = governance?.allowed_tables || [];
            const hasAllowList = allowedTables.length > 0;

            // --- DATABASE SCHEMA ---
            const tablesRes = await client.query(`
                SELECT table_name, column_name, data_type, is_nullable, column_default 
                FROM information_schema.columns 
                WHERE table_schema = 'public' 
                ORDER BY table_name, ordinal_position
            `);
            
            const relRes = await client.query(`
                SELECT
                    tc.table_name, kcu.column_name,
                    ccu.table_name AS foreign_table_name,
                    ccu.column_name AS foreign_column_name
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
                JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
            `);

            const rlsRes = await client.query(`
                SELECT relname, relrowsecurity 
                FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace 
                WHERE nspname = 'public' AND relkind = 'r'
            `);

            // --- EDGE FUNCTIONS (SYSTEM DB) ---
            const edgeRes = await systemPool.query(
                `SELECT name, metadata FROM system.assets WHERE project_slug = $1 AND type = 'edge_function'`,
                [projectSlug]
            );

            // --- FORMATTER ---
            let output = `--- CASCATA PROJECT CONTEXT: ${projectSlug} ---\n`;
            
            // Add Governance Banner
            if (governance?.mode === 'read_only') {
                output += `!!! READ-ONLY MODE ACTIVE: You cannot modify data or schema. !!!\n`;
            }
            if (hasAllowList) {
                output += `!!! SCOPE RESTRICTED: You can only see specific tables. !!!\n`;
            }

            output += `This context is read-only. Use the provided tools to interact with the system.\n\n`;

            output += `=== DATABASE SCHEMA (PostgreSQL) ===\n`;
            const allTables = new Set(tablesRes.rows.map(r => r.table_name));
            
            allTables.forEach(tableName => {
                // GOVERNANCE FILTER
                if (hasAllowList && !allowedTables.includes(tableName)) return;

                const cols = tablesRes.rows.filter(r => r.table_name === tableName);
                const rels = relRes.rows.filter(r => r.table_name === tableName);
                const rls = rlsRes.rows.find(r => r.relname === tableName);
                
                output += `TABLE: ${tableName} [RLS: ${rls?.relrowsecurity ? 'ON' : 'OFF'}]\n`;
                output += `COLUMNS:\n`;
                cols.forEach(c => {
                    output += `  - ${c.column_name} (${c.data_type})${c.is_nullable === 'NO' ? '*' : ''}${c.column_default ? ` DEFAULT ${c.column_default}` : ''}\n`;
                });
                
                if (rels.length > 0) {
                    output += `RELATIONS:\n`;
                    rels.forEach(r => {
                         // Only show relation if target is also allowed (or if no filter)
                        if (!hasAllowList || allowedTables.includes(r.foreign_table_name)) {
                            output += `  - ${r.column_name} -> ${r.foreign_table_name}(${r.foreign_column_name})\n`;
                        }
                    });
                }
                output += "\n";
            });

            if (edgeRes.rows.length > 0) {
                output += `=== EDGE FUNCTIONS (Serverless Logic) ===\n`;
                output += `You can invoke these functions via HTTP POST /edge/{name}\n`;
                edgeRes.rows.forEach(fn => {
                    output += `FUNCTION: ${fn.name}\n`;
                    if (fn.metadata?.notes) output += `  DOCS: ${fn.metadata.notes}\n`;
                    output += `\n`;
                });
            }

            return output;

        } finally {
            client.release();
        }
    }

    /**
     * Executa uma ferramenta solicitada pelo Agente MCP.
     * Suporta: SQL, Introspecção, Busca Vetorial e Gestão de Edge Functions.
     */
    public static async executeTool(
        projectSlug: string,
        pool: Pool, 
        toolName: string, 
        args: any,
        jwtSecret: string,
        governance: any
    ): Promise<any> {
        
        console.log(`[MCP] Agent executing tool: ${toolName} on ${projectSlug}`);

        // GOVERNANCE: Master Kill Switch Check (Redundant safety)
        if (governance?.mcp_enabled === false) {
             throw new Error("MCP Access is disabled for this project.");
        }

        // 1. Tool: run_sql
        if (toolName === 'run_sql') {
            const { sql } = args;
            if (!sql) throw new Error("Missing 'sql' argument");

            // GOVERNANCE: Read-Only Mode Check
            if (governance?.mode === 'read_only') {
                const forbidden = /^(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)/i;
                if (forbidden.test(sql.trim())) {
                     return { isError: true, content: [{ type: "text", text: "Governance Violation: Project is in Read-Only mode. Modification queries are blocked." }] };
                }
            }

            // Audit
            await systemPool.query(
                `INSERT INTO system.api_logs (project_slug, method, path, status_code, client_ip, duration_ms, user_role, payload, geo_info) 
                 VALUES ($1, 'MCP_TOOL', 'mcp/run_sql', 200, '0.0.0.0', 0, 'service_role', $2, '{"agent": "mcp"}')`,
                [projectSlug, JSON.stringify({ sql })]
            );

            // Execute
            const res = await pool.query(sql);
            
            // Webhook Event
            if (!sql.trim().toUpperCase().startsWith('SELECT')) {
                WebhookService.dispatch(projectSlug, 'system', 'AI_ACTION', { sql }, systemPool, jwtSecret).catch(() => {});
            }

            return {
                content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }]
            };
        }

        // 2. Tool: get_table_info
        if (toolName === 'get_table_info') {
             const { table } = args;

             // GOVERNANCE: Visibility Check
             if (governance?.allowed_tables?.length > 0 && !governance.allowed_tables.includes(table)) {
                 return { isError: true, content: [{ type: "text", text: `Governance Violation: Table '${table}' is not in the allowed list.` }] };
             }

             const res = await pool.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = $1
             `, [table]);
             return {
                 content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }]
             };
        }

        // 3. Tool: search_vectors (Memory Access)
        if (toolName === 'search_vectors') {
            const { vector, limit = 5, filter } = args;
            const qdrantUrl = `http://${process.env.QDRANT_HOST || 'qdrant'}:${process.env.QDRANT_PORT || '6333'}`;
            
            try {
                const searchPayload: any = {
                    limit: limit,
                    with_payload: true,
                    with_vector: false
                };

                if (vector && Array.isArray(vector)) {
                    searchPayload.vector = vector;
                }
                if (filter) {
                    searchPayload.filter = filter;
                }

                let endpoint = `${qdrantUrl}/collections/${projectSlug}/points/search`;
                if (!vector) {
                    endpoint = `${qdrantUrl}/collections/${projectSlug}/points/scroll`;
                }

                const res = await axios.post(endpoint, searchPayload);
                return {
                    content: [{ type: "text", text: JSON.stringify(res.data.result, null, 2) }]
                };

            } catch (e: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Vector Search Failed: ${e.message}` }]
                };
            }
        }

        // 4. Tool: manage_edge_function (NEW: Full Stack Power)
        if (toolName === 'manage_edge_function') {
            const { action, name, code, metadata } = args;
            if (!action || !name) throw new Error("Action and Name required");

            // GOVERNANCE: Read-Only Check
            if (governance?.mode === 'read_only' && action !== 'read') {
                 return { isError: true, content: [{ type: "text", text: "Governance Violation: Read-Only mode active. Cannot modify Edge Functions." }] };
            }

            if (action === 'read') {
                 const res = await systemPool.query(
                     "SELECT name, metadata FROM system.assets WHERE project_slug = $1 AND type = 'edge_function' AND name = $2",
                     [projectSlug, name]
                 );
                 if (res.rows.length === 0) return { content: [{ type: "text", text: "Function not found" }] };
                 return { content: [{ type: "text", text: JSON.stringify(res.rows[0], null, 2) }] };
            }

            if (action === 'delete') {
                 await systemPool.query(
                     "DELETE FROM system.assets WHERE project_slug = $1 AND type = 'edge_function' AND name = $2",
                     [projectSlug, name]
                 );
                 return { content: [{ type: "text", text: `Edge Function '${name}' deleted.` }] };
            }

            if (action === 'create' || action === 'update') {
                 if (!code) throw new Error("Code required for create/update");
                 
                 const meta = metadata || {};
                 meta.sql = code; // Store code in sql field for compatibility

                 await systemPool.query(`
                    INSERT INTO system.assets (project_slug, name, type, metadata)
                    VALUES ($1, $2, 'edge_function', $3)
                    ON CONFLICT (project_slug, name, type) 
                    DO UPDATE SET metadata = $3, updated_at = NOW()
                 `, [projectSlug, name, JSON.stringify(meta)]);

                 return { content: [{ type: "text", text: `Edge Function '${name}' deployed successfully.` }] };
            }
        }

        throw new Error(`Unknown tool: ${toolName}`);
    }
}
