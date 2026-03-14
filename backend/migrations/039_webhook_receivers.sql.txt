-- 039_webhook_receivers.sql.txt
CREATE TABLE IF NOT EXISTS system.webhook_receivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path_slug TEXT NOT NULL, -- Endpoint: /api/webhooks/in/:project_slug/:path_slug
    
    -- Security
    auth_method TEXT DEFAULT 'none', -- 'hmac_sha256', 'api_key', 'none'
    secret_key TEXT, -- Signing key or API Key
    
    -- Destination
    target_type TEXT NOT NULL, -- 'AUTOMATION', 'TABLE'
    target_id TEXT NOT NULL, -- Automation ID or Table Name
    
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT uk_webhook_path UNIQUE (project_slug, path_slug)
);

CREATE INDEX IF NOT EXISTS idx_webhook_receivers_project ON system.webhook_receivers(project_slug);
CREATE INDEX IF NOT EXISTS idx_webhook_receivers_active ON system.webhook_receivers(is_active) WHERE is_active = true;
