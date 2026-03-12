-- CASCATA AUTOMATIONS OPS: Performance & Maintenance (Zero Regression)
-- Additive-only migration. No existing columns, tables, or indexes are touched.

-- =============================================================================
-- 1. COMPOSITE INDEX for the hot path: getAutomationStats + listAutomationRuns
--    The existing idx_automation_runs_project and idx_automation_runs_id are
--    single-column. This composite index covers the LEFT JOIN + ORDER BY DESC
--    pattern used by getAutomationStats and the filtered listAutomationRuns.
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_automation_runs_composite
    ON system.automation_runs (project_slug, automation_id, created_at DESC);

-- =============================================================================
-- 2. COVERING INDEX for interceptResponse hot path
--    interceptResponse queries: WHERE project_slug = $1 AND is_active = true
--                                AND trigger_type = 'API_INTERCEPT'
--                                AND (trigger_config->>'table' = $2 OR ...)
--    This partial index covers the first 3 predicates, dramatically reducing
--    the scan space. The JSONB predicate is evaluated on the small result set.
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_automations_intercept_active
    ON system.automations (project_slug, trigger_type)
    WHERE is_active = true AND trigger_type = 'API_INTERCEPT';

-- =============================================================================
-- 3. IMMUTABILITY TRIGGER on automation_runs
--    Same pattern as system.api_logs (migration 009). Prevents manual deletion
--    of execution records — only the purge function can clean them.
-- =============================================================================
DROP TRIGGER IF EXISTS trg_immutable_automation_runs ON system.automation_runs;

CREATE TRIGGER trg_immutable_automation_runs
BEFORE UPDATE OR DELETE ON system.automation_runs
FOR EACH ROW EXECUTE FUNCTION system.enforce_log_immutability();

-- =============================================================================
-- 4. EXTEND purge_old_logs to also clean automation_runs
--    The existing function only purges system.api_logs.
--    We add a companion function specifically for automation runs, following
--    the same SECURITY DEFINER + maintenance_mode pattern.
--    We do NOT modify the original function (zero regression).
-- =============================================================================
CREATE OR REPLACE FUNCTION system.purge_old_automation_runs(p_slug TEXT, p_days INTEGER)
RETURNS INTEGER AS $$
DECLARE
    count INTEGER;
BEGIN
    -- Activate maintenance mode for this transaction only
    PERFORM set_config('cascata.maintenance_mode', 'true', true);

    WITH deleted AS (
        DELETE FROM system.automation_runs
        WHERE project_slug = p_slug
        AND created_at < NOW() - (p_days || ' days')::INTERVAL
        RETURNING id
    )
    SELECT count(*) INTO count FROM deleted;

    RETURN count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
