
import { CascataRequest } from '../types.js';
import { McpService } from '../../services/McpService.js';
import { RootMcpService } from '../../services/RootMcpService.js';
import { systemPool } from '../config/main.js';

export class McpController {

    // --- DATA PLANE (Project Specific) ---

    static async connectSSE(req: CascataRequest, res: any) {
        if (req.userRole !== 'service_role') {
            res.status(403).json({ error: "Access Denied. Requires Service Key for MCP access." });
            return;
        }

        // GOVERNANCE: Global System Kill-Switch Check
        try {
            const sysRes = await systemPool.query("SELECT settings->>'mcp_enabled' as mcp_enabled FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const globalEnabled = sysRes.rows[0]?.mcp_enabled;
            // If explicit false, block. If null/undefined, assume true (default).
            if (globalEnabled === 'false' || globalEnabled === false) {
                 res.status(503).json({ error: "System Governance: Global MCP Access Terminated." });
                 return;
            }
        } catch(e) {}

        // GOVERNANCE: Project Level Check
        const projGovernance = req.project.metadata?.ai_governance;
        if (projGovernance?.mcp_enabled === false) {
            res.status(403).json({ error: "Project Governance: MCP Access Disabled for this project." });
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 15000);
        req.on('close', () => { clearInterval(heartbeat); });
    }

    static async handleMessage(req: CascataRequest, res: any, next: any) {
        if (req.userRole !== 'service_role') {
            return res.status(403).json({ error: "Access Denied" });
        }

        // GOVERNANCE: Project Level Check
        const projGovernance = req.project.metadata?.ai_governance;
        if (projGovernance?.mcp_enabled === false) {
            return res.json({ jsonrpc: "2.0", id: req.body.id, error: { code: -32000, message: "Project Governance: MCP Access Disabled." } });
        }

        const body = req.body;
        
        try {
            if (body.method === 'initialize') {
                return res.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        protocolVersion: "0.1.0",
                        capabilities: { resources: {}, tools: {} },
                        serverInfo: { name: "Cascata MCP (Project)", version: "1.2.0" }
                    }
                });
            }

            if (body.method === 'resources/list') {
                return res.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        resources: [{
                            uri: `cascata://${req.project.slug}/context`,
                            name: "Project Context (Schema + Logic)",
                            mimeType: "text/plain",
                            description: "Database schema, relationships, RLS status, and available Edge Functions."
                        }]
                    }
                });
            }

            if (body.method === 'resources/read') {
                const schema = await McpService.getSchemaContext(req.projectPool!, req.project.slug, projGovernance);
                return res.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: { contents: [{ uri: body.params.uri, mimeType: "text/plain", text: schema }] }
                });
            }

            if (body.method === 'tools/list') {
                return res.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        tools: [
                            {
                                name: "run_sql",
                                description: "Execute a raw SQL query against the database. Use this to create tables, RPCs, triggers, and manage data.",
                                inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] }
                            },
                            {
                                name: "get_table_info",
                                description: "Get detailed column info.",
                                inputSchema: { type: "object", properties: { table: { type: "string" } }, required: ["table"] }
                            },
                            {
                                name: "search_vectors",
                                description: "Search the Qdrant vector database.",
                                inputSchema: { type: "object", properties: { vector: { type: "array", items: { type: "number" } }, limit: { type: "number" } } }
                            },
                            {
                                name: "manage_edge_function",
                                description: "Create, update, read, or delete Serverless Edge Functions (TypeScript/JavaScript).",
                                inputSchema: { 
                                    type: "object", 
                                    properties: { 
                                        action: { type: "string", enum: ["create", "update", "delete", "read"] },
                                        name: { type: "string" },
                                        code: { type: "string", description: "The JS/TS source code (for create/update)" },
                                        metadata: { type: "object", description: "Env vars, timeout, etc." }
                                    }, 
                                    required: ["action", "name"] 
                                }
                            }
                        ]
                    }
                });
            }

            if (body.method === 'tools/call') {
                const result = await McpService.executeTool(
                    req.project.slug, 
                    req.projectPool!, 
                    body.params.name, 
                    body.params.arguments, 
                    req.project.jwt_secret,
                    projGovernance // Pass Governance Config to Service
                );
                return res.json({ jsonrpc: "2.0", id: body.id, result: result });
            }

            res.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });

        } catch (e: any) {
            console.error('[MCP Error]', e);
            res.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: e.message } });
        }
    }

    // --- CONTROL PLANE (System Root) ---

    static async connectRootSSE(req: CascataRequest, res: any) {
        // GOVERNANCE: Global System Kill-Switch Check
        try {
            const sysRes = await systemPool.query("SELECT settings->>'mcp_enabled' as mcp_enabled FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const globalEnabled = sysRes.rows[0]?.mcp_enabled;
            if (globalEnabled === 'false' || globalEnabled === false) {
                 res.status(503).json({ error: "System Governance: Global MCP Access Terminated." });
                 return;
            }
        } catch(e) {}

        // Auth handled by middleware (Cookie/Header Admin Token)
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 15000);
        req.on('close', () => { clearInterval(heartbeat); });
    }

    static async handleRootMessage(req: CascataRequest, res: any) {
        // GOVERNANCE CHECK
        try {
            const sysRes = await systemPool.query("SELECT settings->>'mcp_enabled' as mcp_enabled FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
            const globalEnabled = sysRes.rows[0]?.mcp_enabled;
            if (globalEnabled === 'false' || globalEnabled === false) {
                 return res.json({ jsonrpc: "2.0", id: req.body.id, error: { code: -32000, message: "System Governance: Global MCP Access Terminated." } });
            }
        } catch(e) {}

        const body = req.body;
        
        try {
            if (body.method === 'initialize') {
                return res.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        protocolVersion: "0.1.0",
                        capabilities: { resources: {}, tools: {} },
                        serverInfo: { name: "Cascata Omni-Gateway (Root)", version: "2.0.0" }
                    }
                });
            }

            if (body.method === 'resources/list') {
                return res.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        resources: [{
                            uri: `cascata://system/overview`,
                            name: "System Overview",
                            mimeType: "text/plain",
                            description: "Global status of the Cascata instance (Projects, Load, Health)."
                        }]
                    }
                });
            }

            if (body.method === 'resources/read') {
                const context = await RootMcpService.getSystemContext();
                return res.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: { contents: [{ uri: body.params.uri, mimeType: "text/plain", text: context }] }
                });
            }

            if (body.method === 'tools/list') {
                return res.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        tools: [
                            {
                                name: "list_projects",
                                description: "List all projects in the system.",
                                inputSchema: { type: "object", properties: {} }
                            },
                            {
                                name: "create_project",
                                description: "Provision a new Project (Database, Keys, Vector Store).",
                                inputSchema: { 
                                    type: "object", 
                                    properties: { 
                                        name: { type: "string" }, 
                                        slug: { type: "string", description: "URL-friendly identifier" } 
                                    }, 
                                    required: ["name", "slug"] 
                                }
                            },
                            {
                                name: "get_system_logs",
                                description: "Retrieve recent system-wide audit logs.",
                                inputSchema: { type: "object", properties: {} }
                            }
                        ]
                    }
                });
            }

            if (body.method === 'tools/call') {
                const result = await RootMcpService.executeTool(body.params.name, body.params.arguments);
                return res.json({ jsonrpc: "2.0", id: body.id, result: result });
            }

            res.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
        } catch (e: any) {
            console.error('[Root MCP Error]', e);
            res.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: e.message } });
        }
    }
}
