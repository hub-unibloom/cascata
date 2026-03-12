-- CASCATA AUTOMATIONS SCHEMA (System Database)

-- 1. Automations Table (Workflow Definitions)
CREATE TABLE IF NOT EXISTS system.automations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    
    -- Trigger Logic
    trigger_type TEXT NOT NULL, -- 'DB_EVENT', 'API_INTERCEPT', 'CRON', 'WEBHOOK'
    trigger_config JSONB DEFAULT '{}', -- e.g. { "table": "orders", "event": "INSERT" }
    
    -- Workflow Graph
    nodes JSONB NOT NULL DEFAULT '[]', -- List of Node objects with connections
    
    -- Metadata & Status
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uk_automation_name UNIQUE (project_slug, name)
);

-- 2. Automation Runs (Execution Logs)
CREATE TABLE IF NOT EXISTS system.automation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id UUID REFERENCES system.automations(id) ON DELETE CASCADE,
    project_slug TEXT NOT NULL,
    
    status TEXT NOT NULL, -- 'success', 'failed', 'running'
    execution_time_ms INTEGER,
    
    trigger_payload JSONB,
    final_output JSONB,
    error_message TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_automations_project ON system.automations(project_slug);
CREATE INDEX IF NOT EXISTS idx_automations_active ON system.automations(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_automation_runs_project ON system.automation_runs(project_slug);
CREATE INDEX IF NOT EXISTS idx_automation_runs_id ON system.automation_runs(automation_id);
