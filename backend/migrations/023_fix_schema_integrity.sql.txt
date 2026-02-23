
-- Auto-Healing Migration: Garante a existência das tabelas de segurança
-- Necessário se migrações anteriores falharam parcialmente.

-- 1. Tabela de Grupos de Chaves (Planos)
CREATE TABLE IF NOT EXISTS system.api_key_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    name TEXT NOT NULL,
    rate_limit INTEGER DEFAULT 100,
    burst_limit INTEGER DEFAULT 50,
    window_seconds INTEGER DEFAULT 1,
    crud_limits JSONB DEFAULT '{}'::jsonb,
    scopes TEXT[] DEFAULT '{}',
    rejection_message TEXT,
    nerf_config JSONB DEFAULT '{"enabled": false, "start_delay_seconds": 0, "mode": "speed", "stop_after_seconds": -1}'::jsonb,
    allow_soft_limit BOOLEAN DEFAULT false,
    soft_limit_delay_ms INTEGER DEFAULT 500,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Tabela de API Keys
CREATE TABLE IF NOT EXISTS system.api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    group_id UUID REFERENCES system.api_key_groups(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    lookup_index TEXT,
    prefix TEXT NOT NULL,
    rate_limit INTEGER,
    burst_limit INTEGER,
    scopes TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Índices de Segurança (Idempotentes)
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON system.api_keys (project_slug);
CREATE INDEX IF NOT EXISTS idx_api_keys_lookup ON system.api_keys (lookup_index);
CREATE INDEX IF NOT EXISTS idx_groups_project ON system.api_key_groups (project_slug);

-- 4. Reparo de Colunas em Rate Limits (Legacy Support)
ALTER TABLE system.rate_limits
ADD COLUMN IF NOT EXISTS rate_limit_auth INTEGER,
ADD COLUMN IF NOT EXISTS burst_limit_auth INTEGER,
ADD COLUMN IF NOT EXISTS rate_limit_anon INTEGER,
ADD COLUMN IF NOT EXISTS burst_limit_anon INTEGER,
ADD COLUMN IF NOT EXISTS crud_limits JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS group_limits JSONB DEFAULT '{}'::jsonb;

-- 5. Data Backfill (Se necessário)
UPDATE system.rate_limits 
SET rate_limit_anon = rate_limit, 
    burst_limit_anon = burst_limit,
    rate_limit_auth = rate_limit * 2, 
    burst_limit_auth = burst_limit * 2
WHERE rate_limit_anon IS NULL;
