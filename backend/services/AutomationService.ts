
import { Pool } from 'pg';
import { QueueService } from './QueueService.js';
import { RateLimitService } from './RateLimitService.js';
import { systemPool, SYS_SECRET } from '../src/config/main.js';
import { validateTargetUrl } from '../src/utils/index.js';


/**
 * CASCATA AUTOMATIONS ENGINE
 * High-performance node-based logic orchestrator.
 * Designed for both 'Internal Contacts' (Side-effects) and 'Logic Interception' (API Hijacking).
 */

export interface AutomationNode {
    id: string;
    type: 'trigger' | 'action' | 'logic' | 'condition' | 'response' | 'query' | 'http' | 'transform' | 'data' | 'rpc' | 'convert';
    config: any;
    next?: string[] | { true?: string, false?: string, out?: string, error?: string };
}

export interface AutomationContext {
    vars: Record<string, any>;
    payload: any;
    projectSlug: string;
    jwtSecret: string;
    projectPool: Pool;
    /**
     * The role of the user who triggered this automation.
     * Used to enforce RLS inside SQL nodes. Defaults to 'authenticated'.
     */
    userRole?: string;
    /**
     * Claims from the user's JWT, injected as Postgres LOCAL config vars
     * so that `auth.uid()`, `auth.role()`, etc. work correctly inside SQL nodes.
     */
    jwtClaims?: {
        sub?: string;
        email?: string;
        role?: string;
        identifier?: string;
        provider?: string;
    };
    dryRun?: boolean;
}

// SQL statements that cannot be run inside a restricted session.
// This is a defense-in-depth layer on top of the role restriction.
const FORBIDDEN_SQL_PATTERNS = [
    /;\s*-{2,}/,                                  // Comment after semicolon (multi-statement bypass attempt)
    /COPY\s+/i,                                   // COPY command (file system access)
    /pg_read_file\s*\(/i,                         // File read
    /pg_write_file\s*\(/i,                        // File write
    /pg_ls_dir\s*\(/i,                            // Dir listing
    /pg_terminate_backend\s*\(/i,                 // Kill sessions
    /pg_cancel_backend\s*\(/i,                    // Cancel queries
    /pg_reload_conf\s*\(/i,                       // Reload config
    /ALTER\s+SYSTEM\s+/i,                         // Alter global PG config
    /CREATE\s+OR\s+REPLACE\s+FUNCTION/i,          // Function creation (code injection)
    /\bDO\s+\$\$/i,                               // Anonymous DO blocks (arbitrary PL/pgSQL)
    /PERFORM\s+dblink/i,                          // Remote connections
];

const AUTOMATION_SQL_TIMEOUT_MS = 8000; // 8 seconds max per SQL node

// ---------------------------------------------------------------------------
// INTERCEPTOR CACHE — avoids hitting the DB on every single HTTP request.
// Key: projectSlug, Value: { automations, loadedAt }.
// TTL: 5 minutes. Invalidated explicitly on upsert/delete via invalidateCache().
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedAutomations {
    automations: any[];
    loadedAt: number;
}

export class AutomationService {

    private static interceptorCache = new Map<string, CachedAutomations>();

    /**
     * Invalidates the interceptor cache for a given project.
     * Must be called after any automation upsert or delete.
     */
    public static invalidateCache(projectSlug: string): void {
        this.interceptorCache.delete(projectSlug);
    }

    /**
     * Loads active API_INTERCEPT automations from cache or DB.
     * Returns the full array — filtering by table/event is done by the caller.
     */
    private static async getActiveInterceptors(projectSlug: string): Promise<any[]> {
        const cached = this.interceptorCache.get(projectSlug);
        if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) {
            return cached.automations;
        }

        const res = await systemPool.query(
            `SELECT id, nodes, trigger_config
             FROM system.automations
             WHERE project_slug = $1
             AND is_active = true
             AND trigger_type = 'API_INTERCEPT'`,
            [projectSlug]
        );

        const entry: CachedAutomations = { automations: res.rows, loadedAt: Date.now() };
        this.interceptorCache.set(projectSlug, entry);
        return res.rows;
    }

    /**
     * Intercepts a response before it's sent to the client.
     * Used by DataController for synchronous response transformations.
     */
    public static async interceptResponse(
        projectSlug: string,
        tableName: string,
        eventType: 'INSERT' | 'UPDATE' | 'DELETE' | 'SELECT',
        initialPayload: any,
        context: AutomationContext
    ): Promise<any> {
        try {
            // 1. Read from cache (or populate it on first call / after TTL)
            const allInterceptors = await this.getActiveInterceptors(projectSlug);

            // 2. Filter by table + event in memory (fast — typically < 10 automations per project)
            const matching = allInterceptors.filter(a => {
                const tbl = a.trigger_config?.table;
                const evt = a.trigger_config?.event;
                return (tbl === tableName || tbl === '*') && (evt === eventType || evt === '*');
            });

            if (matching.length === 0) return initialPayload;

            let currentPayload = initialPayload;
            for (const automation of matching) {
                const nodes = automation.nodes as AutomationNode[];
                context.vars = {
                    trigger: { data: currentPayload },
                    $input: currentPayload
                };

                // SYNERGY: Check trigger filters BEFORE starting the workflow
                const triggerNode = nodes.find(n => n.type === 'trigger');
                if (triggerNode && triggerNode.config?.conditions?.length > 0) {
                    const matches = this.evaluateLogic(triggerNode, context);
                    if (!matches) {
                        console.log(`[AutomationEngine] Trigger filters did not match for ${automation.id}. Skipping.`);
                        continue;
                    }
                }

                currentPayload = await this.runAutomationLogged(
                    automation.id,
                    projectSlug,
                    nodes,
                    currentPayload,
                    context
                );
            }

            return currentPayload;
        } catch (e) {
            console.error('[AutomationEngine] Interception Error:', e);
            return initialPayload; // Fail-safe: Return original data
        }

    }

    /**
     * FIX 4 — ASYNC DISPATCH (Non-blocking for DB_EVENT / CRON / WEBHOOK triggers).
     * Called by external event sources (RealtimeService, CronService, WebhookService).
     * Uses setImmediate to yield control BEFORE executing the workflow, so the
     * caller (typically a DB notify handler) is never blocked.
     */
    public static dispatchAsyncTrigger(
        automationId: string,
        projectSlug: string,
        nodes: AutomationNode[],
        triggerPayload: any,
        context: AutomationContext
    ): void {
        // setImmediate schedules in the next iteration of the event loop —
        // the caller returns immediately, with zero latency added to any HTTP path.
        (globalThis as any).setImmediate(() => {
            this.runAutomationLogged(automationId, projectSlug, nodes, triggerPayload, context)
                .catch(e => console.error(`[AutomationEngine:Async] Unhandled error in automation ${automationId}:`, e));
        });
    }

    /**
     * Executes a graph of logic nodes.
     */
    private static async executeWorkflow(
        nodes: AutomationNode[],
        payload: any,
        context: AutomationContext
    ): Promise<any> {
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        const startNode = nodes.find(n => n.type === 'trigger');
        if (!startNode) return payload;

        let currentNode: AutomationNode | undefined = startNode;
        context.vars = context.vars || {};
        context.vars['$input'] = payload;
        context.vars['trigger'] = { data: payload };

        let steps = 0;
        while (currentNode && steps < 100) {
            steps++;
            try {
                const result = await this.processNode(currentNode, context);
                context.vars[currentNode.id] = { data: result };

                if (currentNode.type === 'trigger' && currentNode.config?.conditions?.length > 0 && !result) {
                    console.log(`[AutomationEngine] Workflow aborted: Trigger conditions not met.`);
                    return payload;
                }

                if (currentNode.type === 'response') {
                    return result;
                }

                let nextId: string | undefined;
                if (currentNode.type === 'logic' || currentNode.type === 'condition') {
                    const nextObj = currentNode.next as any;
                    if (nextObj && typeof nextObj === 'object' && !Array.isArray(nextObj)) {
                        nextId = result ? nextObj.true : nextObj.false;
                    } else if (Array.isArray(currentNode.next)) {
                        const nextArr = currentNode.next as string[];
                        nextId = result ? nextArr[0] : nextArr[1];
                    }
                } else {
                    const nextAny = currentNode.next as any;
                    if (currentNode.type === 'http' && result?.__error) {
                        nextId = nextAny?.error;
                    } else {
                        nextId = Array.isArray(currentNode.next) ? currentNode.next[0] : nextAny?.out || nextAny?.next;
                    }
                }

                currentNode = nextId ? nodeMap.get(nextId) : undefined;
            } catch (err: any) {
                console.error(`[AutomationEngine] Node ${currentNode?.id} (${currentNode?.type}) failed:`, err);
                context.vars[currentNode?.id || 'failed_node'] = { error: err.message || 'Node execution failed' };
                // SYNERGY: If an error path exists, follow it; otherwise halt.
                const nextAny = currentNode?.next as any;
                if (nextAny?.error) {
                    currentNode = nodeMap.get(nextAny.error);
                    continue;
                }
                break;
            }
        }

        return context.vars['$output'] || payload;
    }

    /**
     * Node Logic Processor (Exposed for isolated testing)
     */
    public static async processNode(node: AutomationNode, context: AutomationContext): Promise<any> {
        if (!node.config) return null;

        switch (node.type) {
            case 'trigger':
                // SYNERGY: Trigger behaves like a condition node if filters are present
                if (node.config.conditions?.length > 0) {
                    return this.evaluateLogic(node, context);
                }
                return context.vars['$input'] || null;

            case 'transform':
                const transformed = this.resolveObject(node.config.body || node.config.template, context.vars);
                context.vars['$output'] = transformed;
                return transformed;

            case 'query':
                return this.executeSecureSqlNode(node, context);

            case 'http': {
                let targetUrl = this.resolveVariables(node.config.url || '', context.vars);
                if (!targetUrl) throw new Error('[AutomationEngine] HTTP node requires a URL.');

                // --- QUERY PARAMETERS RESOLUTION ---
                if (node.config.query_params && typeof node.config.query_params === 'object') {
                    const resolvedParams = this.resolveObject(node.config.query_params, context.vars);
                    const urlObj = new URL(targetUrl);
                    Object.entries(resolvedParams).forEach(([key, val]) => {
                        if (val !== undefined && val !== null) {
                            urlObj.searchParams.append(key, String(val));
                        }
                    });
                    targetUrl = urlObj.toString();
                }

                await validateTargetUrl(targetUrl);

                const timeout = node.config.timeout || 15000;
                const redirect = node.config.follow_redirects === false ? 'manual' : 'follow';
                const signal = (globalThis as any).AbortSignal?.timeout ? (globalThis as any).AbortSignal.timeout(timeout) : undefined;

                // --- AUTH HEADER INJECTION & VAULT RESOLUTION ---
                // Credentials support direct values or 'vault://NAME_OR_ID' references.
                const authHeaders: Record<string, string> = {};
                const authMode = node.config.auth || 'none';

                if (authMode === 'bearer') {
                    const rawToken = node.config.auth_token;
                    const token = rawToken?.startsWith('vault://')
                        ? await this.resolveVaultSecret(context.projectSlug, rawToken.replace('vault://', ''))
                        : this.resolveVariables(rawToken || '', context.vars);
                    if (token) authHeaders['Authorization'] = `Bearer ${token}`;
                } else if (authMode === 'apikey') {
                    const rawUser = node.config.auth_user || '';
                    const rawPass = node.config.auth_pass || '';

                    const user = rawUser.startsWith('vault://')
                        ? await this.resolveVaultSecret(context.projectSlug, rawUser.replace('vault://', ''))
                        : this.resolveVariables(rawUser, context.vars);

                    const pass = rawPass.startsWith('vault://')
                        ? await this.resolveVaultSecret(context.projectSlug, rawPass.replace('vault://', ''))
                        : this.resolveVariables(rawPass, context.vars);

                    const encoded = (globalThis as any).Buffer.from(`${user}:${pass}`).toString('base64');
                    authHeaders['Authorization'] = `Basic ${encoded}`;
                }

                const method = node.config.method || 'POST';
                const resolvedBody = method !== 'GET'
                    ? JSON.stringify(this.resolveObject(node.config.body, context.vars))
                    : undefined;

                const resolvedHeaders = {
                    'Content-Type': 'application/json',
                    ...authHeaders,
                    ...(node.config.headers ? this.resolveObject(node.config.headers, context.vars) : {})
                };

                const maxRetries = node.config.retries || 0;
                let attempt = 0;
                let lastErr;

                while (attempt <= maxRetries) {
                    try {
                        const response = await (globalThis as any).fetch(targetUrl, {
                            method,
                            body: resolvedBody,
                            headers: resolvedHeaders,
                            redirect,
                            signal
                        });
                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                        }
                        const ct = response.headers.get('content-type') || '';
                        return ct.includes('application/json') ? await response.json() : await response.text();
                    } catch (e) {
                        lastErr = e;
                        attempt++;
                        if (attempt <= maxRetries) await new Promise(r => setTimeout(r, 1000 * attempt));
                    }
                }
                const nextAny = node.next as any;
                if (nextAny?.error) {
                    return { __error: true, message: (lastErr as any)?.message || 'HTTP Failed after retries' };
                }
                throw lastErr;
            }

            case 'convert': {
                const { value, toType } = node.config;
                const source = this.resolveVariables(value || '', context.vars);

                let converted: any = source;
                switch (toType) {
                    case 'int': converted = parseInt(source, 10); break;
                    case 'float': converted = parseFloat(source); break;
                    case 'string': converted = String(source); break;
                    case 'boolean': converted = (source === 'true' || source === '1' || (source as any) === true); break;
                    case 'json': try { converted = JSON.parse(source); } catch { converted = source; } break;
                }
                return converted;
            }

            case 'logic':
            case 'condition':
                return this.evaluateLogic(node, context);

            case 'response':
                return this.resolveObject(node.config.body, context.vars);

            case 'data': {
                const { operation, table, filters, body } = node.config;
                if (!table || !operation) throw new Error('[AutomationEngine] Data node requires a table and operation.');

                const client = await context.projectPool.connect();
                try {
                    // Security Setup (matching executeSecureSqlNode)
                    const userRole = context.userRole || 'authenticated';
                    const claims = context.jwtClaims || {};
                    const quoteLocal = (s: string | undefined | null): string => {
                        if (s === undefined || s === null || s === '') return "''";
                        return `'${String(s).replace(/'/g, "''")}'`;
                    };

                    const setupSql = `
                        SET LOCAL ROLE ${userRole};
                        SET LOCAL "request.jwt.claim.sub" = ${quoteLocal(claims.sub)};
                        SET LOCAL "request.jwt.claim.role" = ${quoteLocal(claims.role)};
                        SET LOCAL "request.jwt.claim.email" = ${quoteLocal(claims.email)};
                        SET LOCAL statement_timeout = '${AUTOMATION_SQL_TIMEOUT_MS}';
                    `;

                    await client.query('BEGIN');
                    await client.query(setupSql);

                    let result;
                    if (operation === 'select') {
                        const whereClauses: string[] = [];
                        const params: any[] = [];
                        if (filters && Array.isArray(filters)) {
                            filters.forEach((f: any, i: number) => {
                                whereClauses.push(`${f.column} ${f.op === 'eq' ? '=' : f.op} $${i + 1}`);
                                params.push(this.getVarSync(f.value, context.vars));
                            });
                        }
                        const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
                        result = await client.query(`SELECT * FROM ${table} ${whereStr}`, params);
                    } else if (operation === 'insert') {
                        const resolvedBody = this.resolveObject(body, context.vars);
                        const keys = Object.keys(resolvedBody);
                        const values = Object.values(resolvedBody);
                        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
                        result = await client.query(
                            `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
                            values
                        );
                    } else if (operation === 'update') {
                        const resolvedBody = this.resolveObject(body, context.vars);
                        const keys = Object.keys(resolvedBody);
                        const values = Object.values(resolvedBody);

                        const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
                        const whereClauses: string[] = [];
                        if (filters && Array.isArray(filters)) {
                            filters.forEach((f: any) => {
                                const idx = values.length + 1;
                                whereClauses.push(`${f.column} ${f.op === 'eq' ? '=' : f.op} $${idx}`);
                                values.push(this.getVarSync(f.value, context.vars));
                            });
                        }
                        const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
                        result = await client.query(
                            `UPDATE ${table} SET ${setClauses.join(', ')} ${whereStr} RETURNING *`,
                            values
                        );
                    } else if (operation === 'upsert') {
                        const resolvedBody = this.resolveObject(body, context.vars);
                        const keys = Object.keys(resolvedBody);
                        const values = Object.values(resolvedBody);
                        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

                        const conflictCols = node.config.conflict_cols || 'id';
                        const updateStr = keys.map(k => `${k} = EXCLUDED.${k}`).join(', ');

                        result = await client.query(
                            `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) 
                             ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateStr} 
                             RETURNING *`,
                            values
                        );
                    } else if (operation === 'delete') {
                        const whereClauses: string[] = [];
                        const params: any[] = [];
                        if (filters && Array.isArray(filters)) {
                            filters.forEach((f: any, i: number) => {
                                whereClauses.push(`${f.column} ${f.op === 'eq' ? '=' : f.op} $${i + 1}`);
                                params.push(this.getVarSync(f.value, context.vars));
                            });
                        }
                        const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
                        result = await client.query(`DELETE FROM ${table} ${whereStr} RETURNING *`, params);
                    }

                    if (context.dryRun) {
                        await client.query('ROLLBACK');
                    } else {
                        await client.query('COMMIT');
                    }
                    return result?.rows || null;
                } catch (e) {
                    await client.query('ROLLBACK').catch(() => { });
                    throw e;
                } finally {
                    client.release();
                }
            }

            case 'rpc': {
                const { function: fnName, args } = node.config;
                if (!fnName) throw new Error('[AutomationEngine] RPC node requires a function name.');

                const client = await context.projectPool.connect();
                try {
                    const userRole = context.userRole || 'authenticated';
                    const claims = context.jwtClaims || {};
                    const quoteLocal = (s: string | undefined | null): string => {
                        if (s === undefined || s === null || s === '') return "''";
                        return `'${String(s).replace(/'/g, "''")}'`;
                    };

                    const setupSql = `
                        SET LOCAL ROLE ${userRole};
                        SET LOCAL "request.jwt.claim.sub" = ${quoteLocal(claims.sub)};
                        SET LOCAL "request.jwt.claim.role" = ${quoteLocal(claims.role)};
                        SET LOCAL "request.jwt.claim.email" = ${quoteLocal(claims.email)};
                        SET LOCAL statement_timeout = '${AUTOMATION_SQL_TIMEOUT_MS}';
                    `;
                    await client.query('BEGIN');
                    await client.query(setupSql);

                    const resolvedArgs = Array.isArray(args) ? this.resolveObject(args, context.vars) : [];
                    const placeholders = resolvedArgs.map((_: any, i: number) => `$${i + 1}`).join(', ');
                    const result = await client.query(`SELECT * FROM ${fnName}(${placeholders})`, resolvedArgs);

                    if (context.dryRun) {
                        await client.query('ROLLBACK');
                    } else {
                        await client.query('COMMIT');
                    }
                    return result.rows;
                } catch (e) {
                    await client.query('ROLLBACK').catch(() => { });
                    throw e;
                } finally {
                    client.release();
                }
            }

            default:
                return null;
        }
    }

    // =========================================================================
    // SECURE SQL NODE EXECUTOR (Hardened v2.1)
    // Inspired by the queryWithRLS ceremony in /src/utils/index.ts.
    //
    // SECURITY LAYERS:
    //   1. Forbidden pattern check (blocks COPY, DO $$, file access, etc.)
    //   2. SET LOCAL ROLE → restricts privileges to the triggering user's role.
    //      The automation engine can NEVER have more DB access than the original user.
    //   3. SET LOCAL statement_timeout → kills long-running/infinite queries.
    //   4. JWT claims are propagated via SET LOCAL so RLS policies (auth.uid(), etc.)
    //      continue to work exactly as they do in regular API calls.
    //   5. All parameters are resolved AFTER the SQL string is finalized and
    //      passed as Postgres $N parameters — never interpolated into the SQL string.
    //   6. Wrapped in a BEGIN/ROLLBACK transaction to prevent DDL auto-commits.
    //      Even if someone bypasses layers 1-4, DDL inside ROLLBACK is a no-op.
    // =========================================================================
    private static async executeSecureSqlNode(node: AutomationNode, context: AutomationContext): Promise<any> {
        const { sql, params, readonly } = node.config;

        if (!sql || typeof sql !== 'string' || sql.trim() === '') {
            return null;
        }

        // --- LAYER 1: FORBIDDEN PATTERN FIREWALL ---
        for (const pattern of FORBIDDEN_SQL_PATTERNS) {
            if (pattern.test(sql)) {
                const err = `[AutomationEngine] SQL Node BLOCKED — forbidden pattern detected: ${pattern.toString()}`;
                console.error(err);
                throw new Error('Security Violation: This SQL statement is not allowed in Automation nodes.');
            }
        }

        // --- LAYER 2: RESOLVE PARAMETERS (never interpolate into the SQL string) ---
        const resolvedParams = Array.isArray(params)
            ? params.map((p: string) => this.getVarSync(p, context.vars))
            : [];

        // --- LAYER 3: DETERMINE SECURITY CONTEXT ---
        const role = context.userRole || 'authenticated';
        const claims = context.jwtClaims || {};

        // We must sanitize the role name — only allow known roles to prevent
        // SET LOCAL ROLE injection (the only remaining vector after parameterization).
        const ALLOWED_ROLES = ['anon', 'authenticated', 'service_role', 'cascata_api_role'];
        const safeRole = ALLOWED_ROLES.includes(role) ? role : 'authenticated';

        const quoteLocal = (s: string | undefined | null): string => {
            if (s === undefined || s === null || s === '') return "''";
            return `'${String(s).replace(/'/g, "''")}'`;
        };

        const setupSql = `
            SET LOCAL ROLE ${safeRole};
            SET LOCAL statement_timeout = '${AUTOMATION_SQL_TIMEOUT_MS}';
            SET LOCAL "request.jwt.claim.sub"        = ${quoteLocal(claims.sub)};
            SET LOCAL "request.jwt.claim.role"       = ${quoteLocal(claims.role || safeRole)};
            SET LOCAL "request.jwt.claim.email"      = ${quoteLocal(claims.email)};
            SET LOCAL "request.jwt.claim.identifier" = ${quoteLocal(claims.identifier)};
            SET LOCAL "request.jwt.claim.provider"   = ${quoteLocal(claims.provider)};
        `;

        // --- LAYER 4: EXECUTE INSIDE AN ISOLATED TRANSACTION ---
        const client = await context.projectPool.connect();
        try {
            await client.query('BEGIN');

            // If the node is configured as read-only (or is a SELECT), add that safeguard too.
            const isSelect = /^\s*SELECT\s/i.test(sql);
            if (readonly === true || isSelect) {
                await client.query('SET TRANSACTION READ ONLY');
            }

            await client.query(setupSql);

            const res = await client.query(sql, resolvedParams);

            if (context.dryRun) {
                await client.query('ROLLBACK');
            } else {
                await client.query('COMMIT');
            }

            return res.rows;
        } catch (e: any) {
            await client.query('ROLLBACK').catch(() => { });
            // Re-wrap timeout errors for clarity in the execution log
            if (e.code === '57014') {
                throw new Error(`[AutomationEngine] SQL Node timeout (>${AUTOMATION_SQL_TIMEOUT_MS}ms). Optimize your query.`);
            }
            throw e;
        } finally {
            client.release();
        }
    }

    // =========================================================================
    // FIX 3 — EXECUTION LOGGING (Ghost Logs Eliminated)
    // Every automation run — synchronous (API_INTERCEPT) or async (DB_EVENT etc.)
    // — now writes a record to system.automation_runs.
    // Captures: status, execution_time_ms, trigger_payload, final_output, error_message.
    // The write uses the systemPool (not the project pool) so it is never blocked
    // by RLS policies on the project DB.
    // =========================================================================
    private static async runAutomationLogged(
        automationId: string,
        projectSlug: string,
        nodes: AutomationNode[],
        triggerPayload: any,
        context: AutomationContext
    ): Promise<any> {
        const startedAt = Date.now();
        let status: 'success' | 'failed' = 'success';
        let finalOutput: any = null;
        let errorMessage: string | null = null;

        try {
            finalOutput = await this.executeWorkflow(nodes, triggerPayload, context);
            return finalOutput;
        } catch (e: any) {
            status = 'failed';
            errorMessage = e?.message || 'Unknown error';
            throw e; // Re-throw so interceptResponse fail-safe still works
        } finally {
            const execution_time_ms = Date.now() - startedAt;
            // Fire-and-forget: we NEVER block on log write.
            // If the DB is down it simply misses a record — better than crashing the workflow.
            systemPool.query(
                `INSERT INTO system.automation_runs
                    (automation_id, project_slug, status, execution_time_ms, trigger_payload, final_output, error_message)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    automationId,
                    projectSlug,
                    status,
                    execution_time_ms,
                    JSON.stringify(triggerPayload),
                    finalOutput !== null ? JSON.stringify(finalOutput) : null,
                    errorMessage
                ]
            ).catch((e: any) => console.error('[AutomationEngine] Failed to write run log:', e.message));
        }
    }

    private static evaluateLogic(node: AutomationNode, context: AutomationContext): boolean {
        const conditions = node.config.conditions || [];
        if (conditions.length === 0 && (node.config.left || node.config.op)) {
            // Support legacy single condition format
            conditions.push(node.config);
        }

        const matchType = node.config.match || 'all';

        const results = conditions.map((c: any) => {
            const leftValue = this.getVarSync(c.left, context.vars);
            const rightValue = c.right;
            switch (c.op) {
                case 'eq': return leftValue == rightValue;
                case 'neq': return leftValue != rightValue;
                case 'gt': return Number(leftValue) > Number(rightValue);
                case 'lt': return Number(leftValue) < Number(rightValue);
                case 'contains': return String(leftValue).includes(String(rightValue));
                case 'regex': try { return new RegExp(String(rightValue)).test(String(leftValue)); } catch { return false; }
                case 'starts_with': return String(leftValue).startsWith(String(rightValue));
                case 'ends_with': return String(leftValue).endsWith(String(rightValue));
                case 'is_empty': return leftValue === null || leftValue === undefined || leftValue === '' || (Array.isArray(leftValue) && leftValue.length === 0);
                default: return false;
            }
        });

        return matchType === 'all' ? results.every((r: any) => r) : results.some((r: any) => r);
    }

    /**
     * Variable Resolver (Logic Engine Core)
     * Replaces {{nodeId.field}} or {{var}} with actual data.
     */
    private static resolveVariables(template: string, vars: Record<string, any>): string {
        if (!template) return '';
        return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
            const val = this.getVarSync(path.trim(), vars);
            return val !== null && val !== undefined ? String(val) : '';
        });
    }

    private static resolveObject(source: any, vars: Record<string, any>): any {
        if (typeof source === 'string') return this.resolveVariables(source, vars);
        if (Array.isArray(source)) return source.map(item => this.resolveObject(item, vars));
        if (typeof source === 'object' && source !== null) {
            const result: any = {};
            for (const key in source) {
                result[key] = this.resolveObject(source[key], vars);
            }
            return result;
        }
        return source;
    }

    private static getVarSync(path: string, vars: Record<string, any>): any {
        if (!path) return null;
        const parts = path.split('.');
        let current = vars;
        for (const part of parts) {
            if (current === null || current === undefined || typeof current !== 'object') return null;
            if (current[part] === undefined) return null;
            current = current[part];
        }
        return current;
    }

    /**
     * Resolves a secret from the project's Secure Vault via Crypto Engine.
     */
    private static async resolveVaultSecret(projectSlug: string, identifier: string): Promise<string | null> {
        try {
            // Support both UUID ID or Case-sensitive Name
            const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
            const where = isId ? 'id = $1' : 'name = $1';

            const res = await systemPool.query(
                `SELECT secret_value
                 FROM system.project_secrets
                 WHERE project_slug = $2 AND ${where} AND type != 'folder'`,
                [identifier, projectSlug]
            );

            if (!res.rows[0]?.secret_value) return null;

            const { CryptoService } = await import('./CryptoService.js');
            return await CryptoService.decrypt(res.rows[0].secret_value);
        } catch (e) {
            console.error(`[AutomationEngine:Vault] Failed to resolve secret ${identifier}:`, e);
            return null;
        }
    }
}
