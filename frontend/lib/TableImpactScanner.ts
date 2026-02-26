/**
 * TableImpactScanner — Enterprise Table Dependency Discovery Engine
 * 
 * THE MOST COMPREHENSIVE table rename safety scanner for PostgreSQL.
 * Scans 13 sources across the PostgreSQL catalog + Cascata's own
 * internal metadata to find every single object that could break
 * when a table is renamed.
 *
 * Architecture mirrors ColumnImpactScanner.ts for consistency.
 *
 * ═══════════════════════════════════════════════════════════════
 * SCAN SOURCES:
 *  1.  Foreign Key Constraints
 *  2.  Indexes (custom, non-primary)
 *  3.  Views (regular)
 *  4.  Materialized Views
 *  5.  Triggers + Trigger Functions
 *  6.  Functions / RPCs (PL/pgSQL, SQL, and others)
 *  7.  RLS Policies (on this table AND on other tables referencing it)
 *  8.  pg_cron Jobs
 *  9.  Rules (legacy pg_rules)
 * 10.  Sequences (owned by columns — naming convention)
 * 11.  Table Inheritance & Partitions
 * 12.  Publications (logical replication)
 * 13.  Cascata Internal: UI Settings + localStorage keys
 * ═══════════════════════════════════════════════════════════════
 */

import { DependencyItem } from './ColumnImpactScanner';

type FetchFn = (url: string, options?: any) => Promise<any>;

// Helper: run a catalog query and return rows (empty array on failure)
// SECURITY FIX: Added params array for parameterized backend execution
async function catalogQuery(
    fetchWithAuth: FetchFn,
    projectId: string,
    schema: string,
    sql: string,
    params: any[] = []
): Promise<any[]> {
    try {
        const res = await fetchWithAuth(`/api/data/${projectId}/query?schema=${schema}`, {
            method: 'POST',
            body: JSON.stringify({ sql, params }),
        });
        return res.rows || [];
    } catch {
        return [];
    }
}

/**
 * Scan ALL dependencies of a table across the entire database
 * and Cascata's internal metadata layer.
 */
export async function scanTableDependencies(
    fetchWithAuth: FetchFn,
    projectId: string,
    schema: string,
    table: string,
    newName: string
): Promise<DependencyItem[]> {
    const deps: DependencyItem[] = [];

    // ════════════════════════════════════════════════════════════
    // 1. FOREIGN KEY CONSTRAINTS
    // ════════════════════════════════════════════════════════════
    // FK constraints where this table is EITHER the source or target.
    // PostgreSQL auto-updates FK OID references on rename — safe, but
    // the user should know who depends on them.
    const fkRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      con.conname AS constraint_name,
      src_rel.relname AS source_table,
      src_ns.nspname AS source_schema,
      tgt_rel.relname AS target_table,
      tgt_ns.nspname AS target_schema,
      ARRAY(
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
      ) AS source_columns,
      ARRAY(
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = con.confrelid AND a.attnum = ANY(con.confkey)
      ) AS target_columns
    FROM pg_constraint con
    JOIN pg_class src_rel ON con.conrelid = src_rel.oid
    JOIN pg_namespace src_ns ON src_rel.relnamespace = src_ns.oid
    JOIN pg_class tgt_rel ON con.confrelid = tgt_rel.oid
    JOIN pg_namespace tgt_ns ON tgt_rel.relnamespace = tgt_ns.oid
    WHERE con.contype = 'f'
      AND (
        (tgt_ns.nspname = $1 AND tgt_rel.relname = $2)
        OR (src_ns.nspname = $1 AND src_rel.relname = $2)
      )
  `, [schema, table]);

    for (const fk of fkRows) {
        const isTarget = fk.target_table === table && fk.target_schema === schema;
        const srcCols = (fk.source_columns || []).join(', ');
        const tgtCols = (fk.target_columns || []).join(', ');
        const detail = isTarget
            ? `${fk.source_schema}.${fk.source_table}(${srcCols}) → ${schema}.${table}(${tgtCols})`
            : `${schema}.${table}(${srcCols}) → ${fk.target_schema}.${fk.target_table}(${tgtCols})`;

        deps.push({
            type: 'fk',
            name: fk.constraint_name,
            detail,
            cascadeSQL: undefined, // PG handles FK follow on rename natively
            severity: 'info',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 2. INDEXES (custom, non-primary)
    // ════════════════════════════════════════════════════════════
    const indexRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      i.relname AS index_name,
      pg_get_indexdef(ix.indexrelid) AS index_def,
      ix.indisunique AS is_unique
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = $1
      AND t.relname = $2
      AND NOT ix.indisprimary
  `, [schema, table]);

    for (const idx of indexRows) {
        deps.push({
            type: 'index',
            name: idx.index_name,
            detail: `${idx.is_unique ? 'UNIQUE ' : ''}INDEX — auto follows rename`,
            cascadeSQL: undefined,
            severity: 'info',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 3. VIEWS (regular)
    // ════════════════════════════════════════════════════════════
    // Views that depend on this table BREAK when table is renamed.
    // PostgreSQL views bind by OID internally, BUT pg_get_viewdef
    // resolves names at read time. The actual dependency is by OID
    // so views DON'T break on rename in modern PG (9.3+).
    // However, we still scan because the view SOURCE TEXT changes,
    // which can confuse users and some migration tools.
    const viewRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT DISTINCT
      v.relname AS view_name,
      vn.nspname AS view_schema,
      pg_get_viewdef(v.oid, true) AS view_def
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class v ON v.oid = r.ev_class
    JOIN pg_namespace vn ON v.relnamespace = vn.oid
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON t.relnamespace = tn.oid
    WHERE d.deptype = 'n'
      AND v.relkind = 'v'
      AND tn.nspname = $1
      AND t.relname = $2
  `, [schema, table]);

    for (const v of viewRows) {
        // Views auto-follow rename via OID dependency, but show as info
        deps.push({
            type: 'view',
            name: `${v.view_schema}.${v.view_name}`,
            detail: `View depends on "${table}" — auto follows rename via OID`,
            cascadeSQL: undefined,
            severity: 'info',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 4. MATERIALIZED VIEWS
    // ════════════════════════════════════════════════════════════
    // Materialized views also bind by OID, so they survive renames,
    // but need REFRESH after structural changes.
    const matViewRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT DISTINCT
      v.relname AS view_name,
      vn.nspname AS view_schema,
      pg_get_viewdef(v.oid, true) AS view_def
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class v ON v.oid = r.ev_class
    JOIN pg_namespace vn ON v.relnamespace = vn.oid
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON t.relnamespace = tn.oid
    WHERE d.deptype = 'n'
      AND v.relkind = 'm'
      AND tn.nspname = $1
      AND t.relname = $2
  `, [schema, table]);

    for (const mv of matViewRows) {
        deps.push({
            type: 'view',
            name: `${mv.view_schema}.${mv.view_name}`,
            detail: `MATERIALIZED VIEW depends on "${table}" — auto follows, may need REFRESH`,
            cascadeSQL: `REFRESH MATERIALIZED VIEW ${mv.view_schema}."${mv.view_name}";`,
            severity: 'warning',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 5. TRIGGERS + TRIGGER FUNCTIONS
    // ════════════════════════════════════════════════════════════
    // Triggers on this table follow the rename automatically.
    // But the trigger FUNCTION body might hardcode the table name.
    const triggerRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      t.tgname AS trigger_name,
      pg_get_triggerdef(t.oid, true) AS trigger_def,
      p.proname AS func_name,
      pn.nspname AS func_schema,
      pg_get_functiondef(p.oid) AS func_def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON p.pronamespace = pn.oid
    WHERE n.nspname = $1
      AND c.relname = $2
      AND NOT t.tgisinternal
  `, [schema, table]);

    for (const tr of triggerRows) {
        const funcBody = tr.func_def || '';
        const tablePattern = new RegExp(`\\b${table}\\b`, 'i');
        const funcReferencesTable = tablePattern.test(funcBody);

        if (funcReferencesTable) {
            // Trigger function body hardcodes the table name — DANGER
            const newDef = funcBody.replace(
                new RegExp(`\\b${table}\\b`, 'g'),
                newName
            );
            deps.push({
                type: 'trigger',
                name: tr.trigger_name,
                detail: `Trigger function "${tr.func_schema}.${tr.func_name}" hardcodes "${table}" in body — will be auto-updated`,
                cascadeSQL: `-- Auto-update trigger function\n${newDef};`,
                severity: 'warning',
            });
        } else {
            deps.push({
                type: 'trigger',
                name: tr.trigger_name,
                detail: `Trigger on "${table}" (fn: ${tr.func_schema}.${tr.func_name}) — auto follows rename`,
                cascadeSQL: undefined,
                severity: 'info',
            });
        }
    }

    // ════════════════════════════════════════════════════════════
    // 6. FUNCTIONS / RPCs
    // ════════════════════════════════════════════════════════════
    // Any function whose body references this table name.
    // Exclude trigger functions (already handled in #5) by checking
    // that the function isn't used as a trigger.
    const funcRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      p.proname AS func_name,
      n.nspname AS func_schema,
      pg_get_functiondef(p.oid) AS func_def,
      l.lanname AS language,
      p.oid AS func_oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_language l ON p.prolang = l.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND pg_get_functiondef(p.oid) ILIKE '%' || $1 || '%'
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid
      )
  `, [table]);

    for (const fn of funcRows) {
        const funcDef = fn.func_def || '';
        const tablePattern = new RegExp(`\\b${table}\\b`, 'i');
        if (!tablePattern.test(funcDef)) continue;

        const lang = (fn.language || '').toLowerCase();
        let cascadeSQL: string | undefined;
        let severity: 'info' | 'warning' | 'danger' = 'warning';

        if (lang === 'sql' || lang === 'plpgsql') {
            const newDef = funcDef.replace(
                new RegExp(`\\b${table}\\b`, 'g'),
                newName
            );
            cascadeSQL = `-- Auto-updated function: ${fn.func_schema}.${fn.func_name}\n${newDef};`;
            severity = 'warning';
        } else {
            severity = 'danger';
        }

        deps.push({
            type: 'function',
            name: `${fn.func_schema}.${fn.func_name}`,
            detail: lang === 'sql' || lang === 'plpgsql'
                ? `Function body references "${table}" — will be auto-updated`
                : `Function body references "${table}" — ⚠ MANUAL review required (${lang})`,
            cascadeSQL,
            severity,
        });
    }

    // ════════════════════════════════════════════════════════════
    // 7. RLS POLICIES
    // ════════════════════════════════════════════════════════════
    // Policies ON this table auto-follow rename.
    // Policies on OTHER tables that reference this table in
    // USING/WITH CHECK expressions will BREAK.
    const policyRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      pol.polname AS policy_name,
      c.relname AS on_table,
      cn.nspname AS on_schema,
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
    JOIN pg_namespace cn ON c.relnamespace = cn.oid
    WHERE cn.nspname = $1
      AND (
        c.relname = $2
        OR pg_get_expr(pol.polqual, pol.polrelid, true) ILIKE '%' || $2 || '%'
        OR pg_get_expr(pol.polwithcheck, pol.polrelid, true) ILIKE '%' || $2 || '%'
      )
  `, [schema, table]);

    for (const pol of policyRows) {
        const usingExpr = pol.using_expr || '';
        const checkExpr = pol.check_expr || '';
        const isOnTable = pol.on_table === table;
        const tablePattern = new RegExp(`\\b${table}\\b`, 'i');
        const referencesInExpr = tablePattern.test(usingExpr) || tablePattern.test(checkExpr);

        if (isOnTable && !referencesInExpr) {
            deps.push({
                type: 'policy',
                name: pol.policy_name,
                detail: `RLS Policy (${pol.command}) on "${table}" — auto follows rename`,
                cascadeSQL: undefined,
                severity: 'info',
            });
        } else if (referencesInExpr) {
            const targetTable = pol.on_table === table ? newName : pol.on_table;
            const targetQualified = `${pol.on_schema}."${targetTable}"`;
            const newUsing = usingExpr.replace(new RegExp(`\\b${table}\\b`, 'g'), newName);
            const newCheck = checkExpr.replace(new RegExp(`\\b${table}\\b`, 'g'), newName);
            const roles = (pol.roles || []).join(', ') || 'PUBLIC';

            let cascadeSQL = `DROP POLICY IF EXISTS "${pol.policy_name}" ON ${targetQualified};\n`;
            cascadeSQL += `CREATE POLICY "${pol.policy_name}" ON ${targetQualified} FOR ${pol.command} TO ${roles}`;
            if (newUsing && newUsing !== 'NULL') cascadeSQL += ` USING (${newUsing})`;
            if (newCheck && newCheck !== 'NULL') cascadeSQL += ` WITH CHECK (${newCheck})`;
            cascadeSQL += ';';

            deps.push({
                type: 'policy',
                name: pol.policy_name,
                detail: `RLS Policy (${pol.command}) references "${table}" in expression — will be recreated`,
                cascadeSQL,
                severity: 'danger',
            });
        }
    }

    // ════════════════════════════════════════════════════════════
    // 8. pg_cron JOBS
    // ════════════════════════════════════════════════════════════
    const cronRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT jobid, jobname, schedule, command
    FROM cron.job
    WHERE command ILIKE '%' || $1 || '%'
  `, [table]);

    for (const cj of cronRows) {
        const cmd = cj.command || '';
        const tablePattern = new RegExp(`\\b${table}\\b`, 'i');
        if (!tablePattern.test(cmd)) continue;

        const newCmd = cmd.replace(new RegExp(`\\b${table}\\b`, 'g'), newName);
        const cascadeSQL = `SELECT cron.alter_job(${cj.jobid}, command := '${newCmd.replace(/'/g, "''")}');`;

        deps.push({
            type: 'cronjob',
            name: cj.jobname || `job_${cj.jobid}`,
            detail: `Cron "${cj.schedule}": ${cmd.substring(0, 80)}${cmd.length > 80 ? '...' : ''}`,
            cascadeSQL,
            severity: 'warning',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 9. RULES (legacy pg_rules)
    // ════════════════════════════════════════════════════════════
    // Legacy rules (not triggers) that reference this table.
    const ruleRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      r.rulename AS rule_name,
      c.relname AS on_table,
      pg_get_ruledef(r.oid, true) AS rule_def
    FROM pg_rewrite r
    JOIN pg_class c ON c.oid = r.ev_class
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = $1
      AND c.relname = $2
      AND r.rulename != '_RETURN'
  `, [schema, table]);

    for (const rl of ruleRows) {
        deps.push({
            type: 'index', // reusing 'index' icon for rules
            name: `RULE: ${rl.rule_name}`,
            detail: `Rule on "${table}" — auto follows rename`,
            cascadeSQL: undefined,
            severity: 'info',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 10. SEQUENCES (owned by columns)
    // ════════════════════════════════════════════════════════════
    // Sequences auto-generated by SERIAL/BIGSERIAL use naming
    // convention: tablename_columnname_seq. They follow the rename
    // internally but their NAME stays with the old table name,
    // which is confusing. We can optionally rename them too.
    const seqRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      s.relname AS seq_name,
      a.attname AS col_name,
      d.refobjid::regclass AS table_ref
    FROM pg_depend d
    JOIN pg_class s ON s.oid = d.objid
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S'
      AND d.deptype = 'a'
      AND n.nspname = $1
      AND t.relname = $2
  `, [schema, table]);

    for (const seq of seqRows) {
        const expectedOldName = `${table}_${seq.col_name}_seq`;
        const expectedNewName = `${newName}_${seq.col_name}_seq`;
        const shouldRename = seq.seq_name === expectedOldName;

        deps.push({
            type: 'index', // reusing icon for sequences
            name: `SEQ: ${seq.seq_name}`,
            detail: shouldRename
                ? `Sequence for "${table}.${seq.col_name}" — will be renamed to "${expectedNewName}"`
                : `Sequence for "${table}.${seq.col_name}" — custom name, kept as-is`,
            cascadeSQL: shouldRename
                ? `ALTER SEQUENCE ${schema}."${expectedOldName}" RENAME TO "${expectedNewName}";`
                : undefined,
            severity: shouldRename ? 'warning' : 'info',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 11. TABLE INHERITANCE & PARTITIONS
    // ════════════════════════════════════════════════════════════
    // Check if this table is a parent (has children) or child (inherits).
    const inheritRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      c.relname AS child_table,
      cn.nspname AS child_schema,
      p.relname AS parent_table,
      pn.nspname AS parent_schema,
      c.relispartition AS is_partition
    FROM pg_inherits inh
    JOIN pg_class c ON c.oid = inh.inhrelid
    JOIN pg_namespace cn ON c.relnamespace = cn.oid
    JOIN pg_class p ON p.oid = inh.inhparent
    JOIN pg_namespace pn ON p.relnamespace = pn.oid
    WHERE (pn.nspname = $1 AND p.relname = $2)
       OR (cn.nspname = $1 AND c.relname = $2)
  `, [schema, table]);

    for (const inh of inheritRows) {
        const isParent = inh.parent_table === table;
        if (isParent) {
            deps.push({
                type: 'fk', // reusing FK icon for parent/child
                name: `${inh.is_partition ? 'PARTITION' : 'CHILD'}: ${inh.child_schema}.${inh.child_table}`,
                detail: inh.is_partition
                    ? `Partition of "${table}" — auto follows rename`
                    : `Inherits from "${table}" — auto follows rename`,
                cascadeSQL: undefined,
                severity: 'info',
            });
        } else {
            deps.push({
                type: 'fk',
                name: `PARENT: ${inh.parent_schema}.${inh.parent_table}`,
                detail: `"${table}" inherits from "${inh.parent_schema}.${inh.parent_table}" — auto follows rename`,
                cascadeSQL: undefined,
                severity: 'info',
            });
        }
    }

    // ════════════════════════════════════════════════════════════
    // 12. PUBLICATIONS (logical replication)
    // ════════════════════════════════════════════════════════════
    // If the table is published for logical replication, subscribers
    // reference it by name and will break.
    const pubRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT
      p.pubname AS pub_name,
      pt.schemaname AS pub_schema,
      pt.tablename AS pub_table
    FROM pg_publication_tables pt
    JOIN pg_publication p ON p.pubname = pt.pubname
    WHERE pt.schemaname = $1
      AND pt.tablename = $2
  `, [schema, table]);

    for (const pub of pubRows) {
        deps.push({
            type: 'cronjob', // reusing cron icon for replication
            name: `PUB: ${pub.pub_name}`,
            detail: `Table published in "${pub.pub_name}" — subscribers reference by name, may need re-sync`,
            cascadeSQL: `-- After rename, update publication:\nALTER PUBLICATION "${pub.pub_name}" DROP TABLE ${schema}."${table}";\nALTER PUBLICATION "${pub.pub_name}" ADD TABLE ${schema}."${newName}";`,
            severity: 'danger',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 13. CASCATA INTERNAL: UI Settings
    // ════════════════════════════════════════════════════════════
    // Cascata stores column widths, order, and formatting preferences
    // in system.ui_settings keyed by (project_slug, table_name).
    // After rename, the old key becomes orphaned. We fix this.
    const uiRows = await catalogQuery(fetchWithAuth, projectId, schema, `
    SELECT table_name
    FROM system.ui_settings
    WHERE project_slug = $1
      AND table_name = $2
  `, [projectId, table]);

    if (uiRows.length > 0) {
        deps.push({
            type: 'index', // info type
            name: `CASCATA: UI Settings`,
            detail: `Column widths, order & format saved for "${table}" — will be migrated to "${newName}"`,
            cascadeSQL: `UPDATE system.ui_settings SET table_name = '${newName}' WHERE project_slug = '${projectId}' AND table_name = '${table}';`,
            severity: 'warning',
        });
    }

    // ════════════════════════════════════════════════════════════
    // 13b. CASCATA INTERNAL: localStorage keys
    // ════════════════════════════════════════════════════════════
    // TablePanel persists sort config in localStorage with key:
    //   cascata_sort_{projectId}_{schema}_{tableName}
    // DatabaseExplorer persists table order with key:
    //   cascata_table_order_{projectId}_{schema}
    // The sort key is orphaned after rename. We note it for
    // client-side cleanup (done in executeTableCascade).
    deps.push({
        type: 'index',
        name: `CASCATA: localStorage`,
        detail: `Sort config key "cascata_sort_${projectId}_${schema}_${table}" — will be migrated client-side`,
        cascadeSQL: undefined, // Handled in executeTableCascade on the client
        severity: 'info',
    });

    return deps;
}

/**
 * Generate the full transactional SQL for a table rename cascade operation.
 *
 * 3-phase approach:
 *   Phase 1: Pre-cascade — drop/modify dependent objects BEFORE rename
 *   Phase 2: The actual ALTER TABLE RENAME
 *   Phase 3: Post-cascade — recreate functions AFTER rename (they reference new name)
 */
export function buildTableRenameCascadeSQL(
    schema: string,
    oldName: string,
    newName: string,
    dependencies: DependencyItem[]
): string {
    const lines: string[] = [];
    lines.push('BEGIN;');
    lines.push('');

    // Phase 1: Pre-cascade — policies, publications, views needing recreation
    const preCascade = dependencies.filter(d =>
        d.cascadeSQL &&
        d.type !== 'function' &&
        !d.name.startsWith('CASCATA:') &&
        !d.name.startsWith('SEQ:')
    );
    if (preCascade.length > 0) {
        lines.push('-- ═══ Phase 1: Update dependent objects ═══');
        for (const dep of preCascade) {
            lines.push(`\n-- [${dep.type.toUpperCase()}] ${dep.name}`);
            lines.push(dep.cascadeSQL!);
        }
        lines.push('');
    }

    // Phase 2: The actual rename
    // SECURITY FIX: Table names used directly in generated SQL should use proper quotation to prevent injection
    // but the actual `newName` value is parameterized. Wait, DDL statements do not support parameterized table names!
    // We must manually escape the identifiers here by duplicating double quotes.
    const safeSchema = schema.replace(/"/g, '""');
    const safeOldName = oldName.replace(/"/g, '""');
    const safeNewName = newName.replace(/"/g, '""');

    lines.push('-- ═══ Phase 2: Rename table ═══');
    lines.push(`ALTER TABLE "${safeSchema}"."${safeOldName}" RENAME TO "${safeNewName}";`);
    lines.push('');

    // Phase 2b: Rename sequences (after table rename)
    const seqDeps = dependencies.filter(d => d.cascadeSQL && d.name.startsWith('SEQ:'));
    if (seqDeps.length > 0) {
        lines.push('-- ═══ Phase 2b: Rename associated sequences ═══');
        for (const dep of seqDeps) {
            lines.push(dep.cascadeSQL!);
        }
        lines.push('');
    }

    // Phase 3: Post-cascade — recreate functions AFTER rename
    const funcDeps = dependencies.filter(d => d.cascadeSQL && d.type === 'function');
    const triggerFuncDeps = dependencies.filter(d => d.cascadeSQL && d.type === 'trigger');
    if (funcDeps.length > 0 || triggerFuncDeps.length > 0) {
        lines.push('-- ═══ Phase 3: Update functions ═══');
        for (const dep of [...triggerFuncDeps, ...funcDeps]) {
            lines.push(`\n-- [${dep.type.toUpperCase()}] ${dep.name}`);
            lines.push(dep.cascadeSQL!);
        }
        lines.push('');
    }

    // Phase 4: Internal metadata migration
    const cascataDeps = dependencies.filter(d => d.cascadeSQL && d.name.startsWith('CASCATA:'));
    if (cascataDeps.length > 0) {
        lines.push('-- ═══ Phase 4: Migrate Cascata metadata ═══');
        for (const dep of cascataDeps) {
            lines.push(dep.cascadeSQL!);
        }
        lines.push('');
    }

    lines.push('COMMIT;');

    return lines.join('\n');
}
