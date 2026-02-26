
import { PoolClient } from 'pg';
import crypto from 'crypto';
import { DatabaseService } from './DatabaseService.js';

interface PostgrestQuery {
    text: string;
    values: any[];
    name?: string; // Prepared Statement Name
    countQuery?: string; // Optional separate query for exact count
}

export class PostgrestService {

    /**
     * Generates a deterministic hash for the SQL string to enable Postgres Prepared Statements.
     * This allows the DB to cache the execution plan, significantly reducing CPU usage for repeated queries.
     */
    private static generateStatementName(sql: string): string {
        // Prefix 'ps_' (Prepared Statement) + MD5 hash of the query structure
        return 'ps_' + crypto.createHash('md5').update(sql).digest('hex').substring(0, 16);
    }

    public static buildQuery(
        tableName: string,
        method: string,
        query: any,
        body: any,
        headers: any
    ): PostgrestQuery {
        // SANITIZATION: Strict Identifier Validation
        if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
            throw new Error("Invalid table name identifier.");
        }

        const safeTable = `"${tableName}"`;
        const params: any[] = [];
        let sql = '';
        let countQuery = '';

        // 1. Extract Reserved Params (Pagination, Select, Order)
        let selectParam = query.select || '*';
        if (selectParam === '%2A') selectParam = '*';

        const orderParam = query.order;
        const limitParam = query.limit;
        const offsetParam = query.offset;
        const onConflictParam = query.on_conflict;

        // 2. Build Filters
        const filters: string[] = [];
        Object.keys(query).forEach(key => {
            if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) return;

            // SANITIZATION: Key must be valid identifier
            if (!/^[a-zA-Z0-9_]+$/.test(key)) return;

            const value = query[key];
            const { clause, val } = this.parseFilter(key, value, params.length + 1);
            if (clause) {
                filters.push(clause);
                if (val !== undefined) {
                    if (Array.isArray(val)) {
                        val.forEach(v => params.push(v));
                    } else {
                        params.push(val);
                    }
                }
            }
        });

        const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

        // 3. Handle Methods
        if (method === 'GET') {
            const columns = this.parseSelect(selectParam);
            const orderBy = this.parseOrder(orderParam);

            let limitClause = '';
            let offsetClause = '';

            if (headers['range']) {
                const rangeMatch = headers['range'].match(/(\d+)-(\d+)?/);
                if (rangeMatch) {
                    const start = parseInt(rangeMatch[1]);
                    const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : undefined;
                    offsetClause = `OFFSET ${start}`;
                    if (end !== undefined) {
                        limitClause = `LIMIT ${end - start + 1}`;
                    }
                }
            }

            if (limitParam) limitClause = `LIMIT ${parseInt(limitParam)}`;
            if (offsetParam) offsetClause = `OFFSET ${parseInt(offsetParam)}`;

            sql = `SELECT ${columns} FROM public.${safeTable} ${whereClause} ${orderBy} ${limitClause} ${offsetClause}`;

            // DoS PROTECTION: Cap count query execution time
            if (headers['prefer'] && headers['prefer'].includes('count=exact')) {
                countQuery = `SELECT COUNT(*) as total FROM public.${safeTable} ${whereClause}`;
            }

        } else if (method === 'POST') {
            const rows = Array.isArray(body) ? body : [body];
            if (rows.length === 0) throw new Error("No data to insert");

            // TIER-3 PADLOCK SANITIZER (Payload Stripping & Logging)
            const lockedColumnsStr = headers['x-cascata-locked-columns'];
            const userRole = headers['x-cascata-role'] || 'anon';
            const projectId = headers['x-cascata-project-id'];
            const clientIp = headers['x-forwarded-for'] || headers['x-real-ip'] || '0.0.0.0';

            if (lockedColumnsStr) {
                try {
                    const lockedColumns = JSON.parse(lockedColumnsStr);
                    // Iterate and sanitize ALL objects in the BULK array
                    for (const row of rows) {
                        for (const [colName, lockLevel] of Object.entries(lockedColumns)) {
                            // If the column exists in the payload, evaluate the lock
                            if (row[colName] !== undefined) {
                                let shouldStrip = false;

                                if (lockLevel === 'immutable') {
                                    shouldStrip = true; // Never allowed externally
                                } else if (lockLevel === 'service_role_only' && userRole !== 'service_role') {
                                    shouldStrip = true; // Blocked for anon/authenticated
                                }
                                // Note: 'insert_only' is allowed during POST/INSERT.

                                if (shouldStrip) {
                                    const spoofedValue = row[colName];
                                    delete row[colName]; // Silently remove the threat

                                    // Fire-and-Forget Radar Log
                                    if (projectId) {
                                        DatabaseService.logSecurityEvent({
                                            projectId,
                                            tableName,
                                            columnName: colName,
                                            attemptedValue: JSON.stringify(spoofedValue),
                                            ip: clientIp
                                        });
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('[PostgrestService] Failed to parse locked columns metadata', e);
                }
            }

            const keys = Object.keys(rows[0]);
            if (keys.length === 0) throw new Error("No valid data to insert after sanitization");

            // SANITIZATION
            keys.forEach(k => {
                if (!/^[a-zA-Z0-9_]+$/.test(k)) throw new Error(`Invalid column name: ${k}`);
            });
            const cols = keys.map(k => `"${k}"`).join(', ');

            const valueGroups: string[] = [];
            let paramIdx = 1;

            // To use Prepared Statements with batch inserts, the structure must be identical.
            // We assume consistent row structure for the batch here.
            rows.forEach(row => {
                const placeholders: string[] = [];
                keys.forEach(k => {
                    placeholders.push(`$${paramIdx++}`);
                    params.push(row[k]);
                });
                valueGroups.push(`(${placeholders.join(', ')})`);
            });

            let upsertClause = '';
            if (headers['prefer'] && headers['prefer'].includes('resolution=merge-duplicates')) {
                const conflictTarget = onConflictParam ? `"${onConflictParam.replace(/[^a-zA-Z0-9_]/g, '')}"` : '"id"';

                // TIER-3 PADLOCK: UPSERT Vulnerability Patch
                // Prevent 'insert_only' columns from being modified during the UPDATE phase of an UPSERT
                let updateKeys = keys;
                if (lockedColumnsStr) {
                    try {
                        const lockedColumns = JSON.parse(lockedColumnsStr);
                        updateKeys = keys.filter(k => lockedColumns[k] !== 'insert_only');
                    } catch (e) { /* silent fail */ }
                }

                if (updateKeys.length > 0) {
                    const updateSet = updateKeys.map(k => `"${k}" = EXCLUDED."${k}"`).join(', ');
                    upsertClause = `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSet}`;
                } else {
                    upsertClause = `ON CONFLICT (${conflictTarget}) DO NOTHING`;
                }

            } else if (headers['prefer'] && headers['prefer'].includes('resolution=ignore-duplicates')) {
                upsertClause = `ON CONFLICT DO NOTHING`;
            }

            const returning = (headers['prefer'] && headers['prefer'].includes('return=minimal')) ? '' : 'RETURNING *';

            sql = `INSERT INTO public.${safeTable} (${cols}) VALUES ${valueGroups.join(', ')} ${upsertClause} ${returning}`;

        } else if (method === 'PATCH') {
            const keys = Object.keys(body);
            if (keys.length === 0) throw new Error("No data to update");

            // TIER-3 PADLOCK SANITIZER (Payload Stripping & Logging for UPDATE)
            const lockedColumnsStr = headers['x-cascata-locked-columns'];
            const userRole = headers['x-cascata-role'] || 'anon';
            const projectId = headers['x-cascata-project-id'];
            const clientIp = headers['x-forwarded-for'] || headers['x-real-ip'] || '0.0.0.0';

            if (lockedColumnsStr) {
                try {
                    const lockedColumns = JSON.parse(lockedColumnsStr);
                    // Single object iteration for PATCH
                    for (const [colName, lockLevel] of Object.entries(lockedColumns)) {
                        if (body[colName] !== undefined) {
                            let shouldStrip = false;

                            if (lockLevel === 'immutable') {
                                shouldStrip = true; // Never allowed externally
                            } else if (lockLevel === 'insert_only') {
                                shouldStrip = true; // NEVER allowed on UPDATE
                            } else if (lockLevel === 'service_role_only' && userRole !== 'service_role') {
                                shouldStrip = true; // Blocked for anon/authenticated
                            }

                            if (shouldStrip) {
                                const spoofedValue = body[colName];
                                delete body[colName]; // Silently remove the threat

                                // Fire-and-Forget Radar Log
                                if (projectId) {
                                    DatabaseService.logSecurityEvent({
                                        projectId,
                                        tableName,
                                        columnName: colName,
                                        attemptedValue: JSON.stringify(spoofedValue),
                                        ip: clientIp
                                    });
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('[PostgrestService] Failed to parse locked columns metadata', e);
                }
            }

            const cleanKeys = Object.keys(body);
            if (cleanKeys.length === 0) throw new Error("No valid data to update after sanitization");

            const setClauses: string[] = [];
            cleanKeys.forEach(k => {
                if (!/^[a-zA-Z0-9_]+$/.test(k)) throw new Error(`Invalid column name: ${k}`);
                setClauses.push(`"${k}" = $${params.length + 1}`);
                params.push(body[k]);
            });

            const updateFilters: string[] = [];
            Object.keys(query).forEach(key => {
                if (['select', 'order', 'limit', 'offset'].includes(key)) return;
                // SANITIZATION
                if (!/^[a-zA-Z0-9_]+$/.test(key)) return;

                const value = query[key];
                const { clause, val } = this.parseFilter(key, value, params.length + 1);
                if (clause) {
                    updateFilters.push(clause);
                    if (val !== undefined) params.push(val);
                }
            });

            const updateWhere = updateFilters.length > 0 ? `WHERE ${updateFilters.join(' AND ')}` : '';
            if (!updateWhere) throw new Error("UPDATE requires a filter (e.g. ?id=eq.1)");

            const returning = (headers['prefer'] && headers['prefer'].includes('return=representation')) ? 'RETURNING *' : '';

            sql = `UPDATE public.${safeTable} SET ${setClauses.join(', ')} ${updateWhere} ${returning}`;

        } else if (method === 'DELETE') {
            const deleteFilters: string[] = [];
            Object.keys(query).forEach(key => {
                if (['select', 'order', 'limit', 'offset'].includes(key)) return;
                // SANITIZATION
                if (!/^[a-zA-Z0-9_]+$/.test(key)) return;

                const value = query[key];
                const { clause, val } = this.parseFilter(key, value, params.length + 1);
                if (clause) {
                    deleteFilters.push(clause);
                    if (val !== undefined) params.push(val);
                }
            });

            const deleteWhere = deleteFilters.length > 0 ? `WHERE ${deleteFilters.join(' AND ')}` : '';
            if (!deleteWhere) throw new Error("DELETE requires a filter (e.g. ?id=eq.1)");

            const returning = (headers['prefer'] && headers['prefer'].includes('return=representation')) ? 'RETURNING *' : '';

            sql = `DELETE FROM public.${safeTable} ${deleteWhere} ${returning}`;
        }

        // Generate Prepared Statement Name
        // Only queries with parameters benefit significantly from prepared statements
        const name = params.length > 0 ? this.generateStatementName(sql) : undefined;

        return { text: sql, values: params, name, countQuery };
    }

    private static parseSelect(selectParam: string): string {
        if (!selectParam || selectParam === '*' || selectParam === '%2A') return '*';
        return selectParam.split(',').map(c => {
            const part = c.trim();
            // Basic sanitization, ideally should be stricter
            if (!/^[a-zA-Z0-9_:\->.\s\(\)]+$/.test(part)) return '';

            if (part.includes(':') && !part.includes('::')) {
                const [col, alias] = part.split(':');
                return `"${col.trim()}" AS "${alias.trim()}"`;
            }
            if (part.includes('(') || part.includes('->') || part.includes('.')) {
                return part;
            }
            return `"${part}"`;
        }).filter(Boolean).join(', ');
    }

    private static parseOrder(orderParam: string): string {
        if (!orderParam) return '';
        const parts = orderParam.split(',');
        const orders = parts.map(p => {
            const [col, dir] = p.split('.');
            const cleanCol = col.replace(/[^a-zA-Z0-9_]/g, '');
            const safeCol = `"${cleanCol}"`;
            const safeDir = (dir && dir.toLowerCase() === 'desc') ? 'DESC' : 'ASC';
            let nulls = '';
            if (p.includes('nullsfirst')) nulls = ' NULLS FIRST';
            if (p.includes('nullslast')) nulls = ' NULLS LAST';
            return `${safeCol} ${safeDir}${nulls}`;
        });
        return `ORDER BY ${orders.join(', ')}`;
    }

    private static parseFilter(key: string, value: string, paramIndex: number): { clause: string, val: any } {
        const column = `"${key}"`;

        // ROBUST PARSER FIX: Split only on the first dot
        // This preserves values like "user.name@domain.com"
        const dotIndex = value.indexOf('.');

        if (dotIndex === -1) {
            // Implicit Equality (no operator)
            return { clause: `${column} = $${paramIndex}`, val: value };
        }

        const op = value.substring(0, dotIndex);
        const rawVal = value.substring(dotIndex + 1);

        switch (op) {
            case 'eq': return { clause: `${column} = $${paramIndex}`, val: rawVal };
            case 'neq': return { clause: `${column} != $${paramIndex}`, val: rawVal };
            case 'gt': return { clause: `${column} > $${paramIndex}`, val: rawVal };
            case 'gte': return { clause: `${column} >= $${paramIndex}`, val: rawVal };
            case 'lt': return { clause: `${column} < $${paramIndex}`, val: rawVal };
            case 'lte': return { clause: `${column} <= $${paramIndex}`, val: rawVal };
            case 'like': return { clause: `${column} LIKE $${paramIndex}`, val: rawVal.replace(/\*/g, '%') };
            case 'ilike': return { clause: `${column} ILIKE $${paramIndex}`, val: rawVal.replace(/\*/g, '%') };
            case 'is':
                if (rawVal === 'null') return { clause: `${column} IS NULL`, val: undefined };
                if (rawVal === 'true') return { clause: `${column} IS TRUE`, val: undefined };
                if (rawVal === 'false') return { clause: `${column} IS FALSE`, val: undefined };
                return { clause: '', val: undefined };
            case 'in':
                let cleanVal = rawVal;
                if (cleanVal.startsWith('(') && cleanVal.endsWith(')')) cleanVal = cleanVal.slice(1, -1);
                if (!cleanVal.trim()) return { clause: '1 = 0', val: undefined };
                // Simple CSV splitter
                const arr = cleanVal.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
                return { clause: `${column} = ANY($${paramIndex})`, val: arr };
            case 'cs': return { clause: `${column} @> $${paramIndex}`, val: rawVal };
            case 'cd': return { clause: `${column} <@ $${paramIndex}`, val: rawVal };
            default: return { clause: `${column} = $${paramIndex}`, val: value };
        }
    }
}
