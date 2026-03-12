
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
    type: 'trigger' | 'action' | 'condition' | 'response' | 'query' | 'http' | 'transform';
    config: any;
    next?: string[];
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

        // Simple linear sequence for Phase 1. Branching/Parallelism to come in Phase 2.
        while (currentNode) {
            try {
                const result = await this.processNode(currentNode, context);
                
                // If the node type is 'response', we return its content as the final interception result
                if (currentNode.type === 'response') {
                    return result;
                }

                // If node is a condition, choose path based on result
                let nextId: string | undefined;
                if (currentNode.type === 'condition') {
                    nextId = result ? currentNode.next?.[0] : currentNode.next?.[1];
                } else {
                    nextId = currentNode.next?.[0];
                }

                currentNode = nextId ? nodeMap.get(nextId) : undefined;
            } catch (err) {
                if (currentNode) {
                    console.error(`[AutomationEngine] Node ${currentNode.id} (${currentNode.type}) failed:`, err);
                }
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
                // Logic/Variable mapping node
                // (No-code on front, but here we can evaluate templates or basic JS expressions)
                const transformed = this.resolveVariables(node.config.template, context.vars);
                context.vars[node.id] = transformed;
                context.vars['$output'] = transformed;
                return transformed;

            case 'query':
                // Internal DB Query node
                const { sql, params } = node.config;
                const resolvedParams = (params || []).map((p: string) => this.getVarSync(p, context.vars));
                const res = await context.projectPool.query(sql, resolvedParams);
                context.vars[node.id] = res.rows;
                return res.rows;

            case 'http':
                // External contact node (HTTP/PIX/etc)
                // Use fetch for high-performance Node 18+ native requests
                const response = await fetch(node.config.url, {
                    method: node.config.method || 'POST',
                    body: JSON.stringify(this.resolveObject(node.config.body, context.vars)),
                    headers: { 'Content-Type': 'application/json' }
                });
                const data = await response.json();
                context.vars[node.id] = data;
                return data;

            case 'condition':
                // logic node: check variable vs value
                const left = this.getVarSync(node.config.left, context.vars);
                const right = node.config.right;
                switch (node.config.op) {
                    case 'eq': return left == right;
                    case 'neq': return left != right;
                    case 'gt': return Number(left) > Number(right);
                    case 'lt': return Number(left) < Number(right);
                    case 'contains': return String(left).includes(String(right));
                    default: return false;
                }

            case 'response':
                // The "Interceptor Exit" - Defines what return to the API client
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
