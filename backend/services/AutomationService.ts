
import { Pool } from 'pg';
import { QueueService } from './QueueService.js';
import { RateLimitService } from './RateLimitService.js';
import { systemPool } from '../src/config/main.js';

/**
 * CASCATA AUTOMATIONS ENGINE
 * High-performance node-based logic orchestrator.
 * Designed for both 'Internal Contacts' (Side-effects) and 'Logic Interception' (API Hijacking).
 */

export interface AutomationNode {
    id: string;
    type: 'trigger' | 'action' | 'logic' | 'condition' | 'response' | 'query' | 'http' | 'transform';
    config: any;
    next?: string[] | { true?: string, false?: string };
}

export interface AutomationContext {
    vars: Record<string, any>;
    payload: any;
    projectSlug: string;
    jwtSecret: string;
    projectPool: Pool;
}

export class AutomationService {

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
            // 1. Fetch active interception automations for this project/table
            const res = await systemPool.query(
                `SELECT nodes, trigger_config 
                 FROM system.automations 
                 WHERE project_slug = $1 
                 AND is_active = true 
                 AND trigger_type = 'API_INTERCEPT'
                 AND (trigger_config->>'table' = $2 OR trigger_config->>'table' = '*')
                 AND (trigger_config->>'event' = $3 OR trigger_config->>'event' = '*')`,
                [projectSlug, tableName, eventType]
            );

            if (res.rows.length === 0) return initialPayload;

            let currentPayload = initialPayload;
            for (const automation of res.rows) {
                const nodes = automation.nodes as AutomationNode[];
                currentPayload = await this.executeWorkflow(nodes, currentPayload, context);
            }

            return currentPayload;
        } catch (e) {
            console.error('[AutomationEngine] Interception Error:', e);
            return initialPayload; // Fail-safe: Return original data
        }
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
        context.vars['$input'] = payload;
        context.vars['trigger'] = { data: payload };

        let steps = 0;
        while (currentNode && steps < 100) {
            steps++;
            try {
                const result = await this.processNode(currentNode, context);
                context.vars[currentNode.id] = { data: result };
                
                if (currentNode.type === 'response') {
                    return result;
                }

                let nextId: string | undefined;
                if (currentNode.type === 'logic' || currentNode.type === 'condition') {
                    const nextObj = currentNode.next as any;
                    if (nextObj && typeof nextObj === 'object' && !Array.isArray(nextObj)) {
                        nextId = result ? nextObj.true : nextObj.false;
                    } else if (Array.isArray(currentNode.next)) {
                        nextId = result ? currentNode.next[0] : currentNode.next[1];
                    }
                } else {
                    nextId = Array.isArray(currentNode.next) ? currentNode.next[0] : (currentNode.next as any)?.out;
                }

                currentNode = nextId ? nodeMap.get(nextId) : undefined;
            } catch (err) {
                console.error(`[AutomationEngine] Node ${currentNode.id} (${currentNode.type}) failed:`, err);
                break;
            }
        }

        return context.vars['$output'] || payload;
    }

    /**
     * Node Logic Processor
     */
    private static async processNode(node: AutomationNode, context: AutomationContext): Promise<any> {
        switch (node.type) {
            case 'transform':
                const transformed = this.resolveObject(node.config.body || node.config.template, context.vars);
                context.vars['$output'] = transformed;
                return transformed;

            case 'query':
                const { sql, params } = node.config;
                const resolvedParams = (params || []).map((p: string) => this.getVarSync(p, context.vars));
                const res = await context.projectPool.query(sql, resolvedParams);
                return res.rows;

            case 'http':
                const maxRetries = node.config.retries || 0;
                let attempt = 0;
                let lastErr;

                while (attempt <= maxRetries) {
                    try {
                        const response = await fetch(node.config.url, {
                            method: node.config.method || 'POST',
                            body: node.config.method !== 'GET' ? JSON.stringify(this.resolveObject(node.config.body, context.vars)) : undefined,
                            headers: { 
                                'Content-Type': 'application/json',
                                ...(node.config.headers ? this.resolveObject(node.config.headers, context.vars) : {})
                            }
                        });
                        return await response.json();
                    } catch (e) {
                        lastErr = e;
                        attempt++;
                        if (attempt <= maxRetries) await new Promise(r => setTimeout(r, 1000 * attempt));
                    }
                }
                throw lastErr;

            case 'logic':
            case 'condition':
                const conditions = node.config.conditions || [node.config];
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
                        default: return false;
                    }
                });

                return matchType === 'all' ? results.every((r: any) => r) : results.some((r: any) => r);

            case 'response':
                return this.resolveObject(node.config.body, context.vars);

            default:
                return null;
        }
    }

    /**
     * Variable Resolver (Logic Engine Core)
     * Replaces {{nodeId.field}} or {{var}} with actual data.
     */
    private static resolveVariables(template: string, vars: Record<string, any>): string {
        if (!template) return '';
        return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
            return this.getVarSync(path.trim(), vars) || '';
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
        const parts = path.split('.');
        let current = vars;
        for (const part of parts) {
            if (current[part] === undefined) return null;
            current = current[part];
        }
        return current;
    }
}
