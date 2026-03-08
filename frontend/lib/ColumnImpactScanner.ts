/**
 * ColumnImpactScanner — Enterprise Dependency Discovery Engine
 * 
 * Scans 7 PostgreSQL catalog sources to find every object
 * referencing a given column. Used by the Protocolo Cascata
 * before rename/delete operations.
 */

export interface DependencyItem {
    type: 'fk' | 'index' | 'view' | 'trigger' | 'function' | 'policy' | 'cronjob';
    name: string;
    detail: string;
    cascadeSQL?: string;
    severity: 'info' | 'warning' | 'danger';
}

type FetchFn = (url: string, options?: any) => Promise<any>;

// Helper: run a catalog query and return rows (empty array on failure)
async function catalogQuery(
    fetchWithAuth: FetchFn,
    projectId: string,
    schema: string,
    sql: string
): Promise<any[]> {
    try {
        const res = await fetchWithAuth(`/api/data/${projectId}/query?schema=${schema}`, {
            method: 'POST',
            body: JSON.stringify({ sql }),
        });
        return res.rows || [];
    } catch {
        return [];
    }
}

/**
 * Scan ALL dependencies of a column across the entire database.
 */
export async function scanColumnDependencies(
    fetchWithAuth: FetchFn,
    projectId: string,
    schema: string,
    table: string,
    column: string,
    action: 'rename' | 'delete',
    newName?: string
): Promise<DependencyItem[]> {
    const deps: DependencyItem[] = [];

    // ── 1. Foreign Keys ─────────────────────────────────────────
    const fkRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      con.conname AS constraint_name,
      src_rel.relname AS source_table,
      src_att.attname AS source_column,
      tgt_rel.relname AS target_table,
      tgt_att.attname AS target_column
    FROM pg_constraint con
    JOIN pg_class src_rel ON con.conrelid = src_rel.oid
    JOIN pg_namespace src_ns ON src_rel.relnamespace = src_ns.oid
    JOIN pg_class tgt_rel ON con.confrelid = tgt_rel.oid
    JOIN pg_attribute src_att ON src_att.attrelid = con.conrelid 
      AND src_att.attnum = ANY(con.conkey)
    JOIN pg_attribute tgt_att ON tgt_att.attrelid = con.confrelid 
      AND tgt_att.attnum = ANY(con.confkey)
    WHERE con.contype = 'f'
      AND src_ns.nspname = '${schema}'
      AND (
        (tgt_rel.relname = '${table}' AND tgt_att.attname = '${column}')
        OR (src_rel.relname = '${table}' AND src_att.attname = '${column}')
      )
  `);

    for (const fk of fkRows) {
        const isTarget = fk.target_table === table && fk.target_column === column;
        const detail = isTarget
            ? `${fk.source_table}.${fk.source_column} → ${table}.${column}`
            : `${table}.${column} → ${fk.target_table}.${fk.target_column}`;

        let cascadeSQL: string | undefined;
        if (action === 'delete') {
            cascadeSQL = `ALTER TABLE ${schema}."${fk.source_table}" DROP CONSTRAINT "${fk.constraint_name}";`;
        } else if (action === 'rename' && newName) {
            // FK constraints auto-follow column renames in PG. No SQL needed.
            // But if the source side references via name, we may need to recreate.
            cascadeSQL = undefined; // PG handles FK follow on rename natively
        }

        deps.push({
            type: 'fk',
            name: fk.constraint_name,
            detail,
            cascadeSQL,
            severity: 'danger',
        });
    }

    // ── 2. Indexes ──────────────────────────────────────────────
    const indexRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      i.relname AS index_name,
      a.attname AS column_name,
      ix.indisunique AS is_unique,
      pg_get_indexdef(ix.indexid) AS index_def
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE n.nspname = '${schema}'
      AND t.relname = '${table}'
      AND a.attname = '${column}'
      AND NOT ix.indisprimary
  `);

    for (const idx of indexRows) {
        let cascadeSQL: string | undefined;
        if (action === 'delete') {
            cascadeSQL = `DROP INDEX IF EXISTS ${schema}."${idx.index_name}";`;
        } else if (action === 'rename' && newName) {
            // Drop and recreate with new column name
            const newDef = (idx.index_def || '').replace(
                new RegExp(`\\b${column}\\b`, 'g'),
                newName
            );
            cascadeSQL = `DROP INDEX IF EXISTS ${schema}."${idx.index_name}";\n${newDef};`;
        }

        deps.push({
            type: 'index',
            name: idx.index_name,
            detail: `${idx.is_unique ? 'UNIQUE ' : ''}INDEX on ${table}(${column})`,
            cascadeSQL,
            severity: 'warning',
        });
    }

    // ── 3. Views ────────────────────────────────────────────────
    const viewRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT DISTINCT
      v.relname AS view_name,
      pg_get_viewdef(v.oid, true) AS view_def
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class v ON v.oid = r.ev_class
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace n ON v.relnamespace = n.oid
    WHERE d.deptype = 'n'
      AND v.relkind = 'v'
      AND t.relname = '${table}'
      AND n.nspname = '${schema}'
      AND pg_get_viewdef(v.oid, true) ILIKE '%${column}%'
  `);

    for (const v of viewRows) {
        let cascadeSQL: string | undefined;
        if (action === 'delete') {
            cascadeSQL = `DROP VIEW IF EXISTS ${schema}."${v.view_name}" CASCADE;`;
        } else if (action === 'rename' && newName) {
            const newDef = (v.view_def || '').replace(
                new RegExp(`\\b${column}\\b`, 'g'),
                newName
            );
            cascadeSQL = `CREATE OR REPLACE VIEW ${schema}."${v.view_name}" AS ${newDef}`;
        }

        deps.push({
            type: 'view',
            name: v.view_name,
            detail: `View references "${column}" in definition`,
            cascadeSQL,
            severity: 'warning',
        });
    }

    // ── 4. Triggers ─────────────────────────────────────────────
    const triggerRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      t.tgname AS trigger_name,
      pg_get_triggerdef(t.oid, true) AS trigger_def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = '${schema}'
      AND c.relname = '${table}'
      AND NOT t.tgisinternal
  `);

    for (const tr of triggerRows) {
        // Triggers on the table are impacted if the column is deleted
        // but don't necessarily reference the column by name in their definition
        const trigDef = tr.trigger_def || '';
        const referencesColumn = trigDef.toLowerCase().includes(column.toLowerCase());

        if (action === 'delete' || referencesColumn) {
            deps.push({
                type: 'trigger',
                name: tr.trigger_name,
                detail: referencesColumn
                    ? `Trigger references "${column}" in definition`
                    : `Trigger on table "${table}" (may be affected)`,
                cascadeSQL: action === 'delete'
                    ? `DROP TRIGGER IF EXISTS "${tr.trigger_name}" ON ${schema}."${table}";`
                    : undefined,
                severity: 'info',
            });
        }
    }

    // ── 5. Functions / RPCs ─────────────────────────────────────
    const funcRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      p.proname AS func_name,
      n.nspname AS func_schema,
      pg_get_functiondef(p.oid) AS func_def
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND pg_get_functiondef(p.oid) ILIKE '%${column}%'
      AND pg_get_functiondef(p.oid) ILIKE '%${table}%'
  `);

    for (const fn of funcRows) {
        deps.push({
            type: 'function',
            name: `${fn.func_schema}.${fn.func_name}`,
            detail: `Function body references "${table}.${column}" — ⚠ Manual review required`,
            cascadeSQL: undefined, // Cannot auto-fix function bodies safely
            severity: 'warning',
        });
    }

    // ── 6. RLS Policies ─────────────────────────────────────────
    const policyRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      pol.polname AS policy_name,
      pg_get_expr(pol.polqual, pol.polrelid, true) AS using_expr,
      pg_get_expr(pol.polwithcheck, pol.polrelid, true) AS check_expr,
      CASE pol.polcmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        WHEN '*' THEN 'ALL'
      END AS command,
      ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)) AS roles
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = '${schema}'
      AND c.relname = '${table}'
      AND (
        pg_get_expr(pol.polqual, pol.polrelid, true) ILIKE '%${column}%'
        OR pg_get_expr(pol.polwithcheck, pol.polrelid, true) ILIKE '%${column}%'
      )
  `);

    for (const pol of policyRows) {
        let cascadeSQL: string | undefined;
        if (action === 'delete') {
            cascadeSQL = `DROP POLICY IF EXISTS "${pol.policy_name}" ON ${schema}."${table}";`;
        } else if (action === 'rename' && newName) {
            // Recreate policy with new column name
            const newUsing = (pol.using_expr || '').replace(
                new RegExp(`\\b${column}\\b`, 'g'),
                newName
            );
            const newCheck = (pol.check_expr || '').replace(
                new RegExp(`\\b${column}\\b`, 'g'),
                newName
            );
            const roles = (pol.roles || []).join(', ') || 'PUBLIC';
            cascadeSQL = `DROP POLICY IF EXISTS "${pol.policy_name}" ON ${schema}."${table}";\n`;
            cascadeSQL += `CREATE POLICY "${pol.policy_name}" ON ${schema}."${table}" FOR ${pol.command} TO ${roles}`;
            if (newUsing && newUsing !== 'NULL') cascadeSQL += ` USING (${newUsing})`;
            if (newCheck && newCheck !== 'NULL') cascadeSQL += ` WITH CHECK (${newCheck})`;
            cascadeSQL += ';';
        }

        deps.push({
            type: 'policy',
            name: pol.policy_name,
            detail: `RLS Policy (${pol.command}) references "${column}"`,
            cascadeSQL,
            severity: 'danger',
        });
    }

    // ── 7. pg_cron Jobs ─────────────────────────────────────────
    const cronRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT jobid, jobname, schedule, command
    FROM cron.job
    WHERE command ILIKE '%${table}%'
      AND command ILIKE '%${column}%'
  `);

    for (const cj of cronRows) {
        let cascadeSQL: string | undefined;
        if (action === 'rename' && newName) {
            const newCmd = (cj.command || '').replace(
                new RegExp(`\\b${column}\\b`, 'g'),
                newName
            );
            cascadeSQL = `SELECT cron.alter_job(${cj.jobid}, command := '${newCmd.replace(/'/g, "''")}');`;
        } else if (action === 'delete') {
            cascadeSQL = `SELECT cron.unschedule(${cj.jobid});`;
        }

        deps.push({
            type: 'cronjob',
            name: cj.jobname || `job_${cj.jobid}`,
            detail: `Cron: "${cj.schedule}" — ${(cj.command || '').substring(0, 80)}...`,
            cascadeSQL,
            severity: 'warning',
        });
    }

    return deps;
}

/**
 * Generate the full transactional SQL for a cascade operation.
 */
export function buildCascadeSQL(
    schema: string,
    table: string,
    column: string,
    action: 'rename' | 'delete',
    newName: string | undefined,
    dependencies: DependencyItem[]
): string {
    const lines: string[] = [];
    lines.push('BEGIN;');
    lines.push('');

    // Pre-cascade: drop/modify dependent objects
    const preCascade = dependencies.filter(d => d.cascadeSQL);
    if (preCascade.length > 0) {
        lines.push('-- Cascade: Update dependent objects');
        for (const dep of preCascade) {
            lines.push(`-- [${dep.type.toUpperCase()}] ${dep.name}`);
            lines.push(dep.cascadeSQL!);
            lines.push('');
        }
    }

    // Main operation
    if (action === 'rename' && newName) {
        lines.push('-- Main: Rename column');
        lines.push(`ALTER TABLE ${schema}."${table}" RENAME COLUMN "${column}" TO "${newName}";`);
    } else if (action === 'delete') {
        lines.push('-- Main: Drop column');
        lines.push(`ALTER TABLE ${schema}."${table}" DROP COLUMN "${column}" CASCADE;`);
    }

    lines.push('');
    lines.push('COMMIT;');

    return lines.join('\n');
}
