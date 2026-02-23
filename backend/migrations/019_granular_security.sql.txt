
-- Tabela de Grupos de Chaves (Planos)
CREATE TABLE IF NOT EXISTS system.api_key_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    name TEXT NOT NULL,
    
    -- Limites Padrão (Podem ser sobrescritos por regra)
    rate_limit INTEGER DEFAULT 100,
    burst_limit INTEGER DEFAULT 50,
    window_seconds INTEGER DEFAULT 1,
    
    -- Configs Extras
    allow_soft_limit BOOLEAN DEFAULT false,
    soft_limit_delay_ms INTEGER DEFAULT 500,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabela de API Keys (FALTAVA O CREATE TABLE NA VERSÃO ANTERIOR)
CREATE TABLE IF NOT EXISTS system.api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    group_id UUID REFERENCES system.api_key_groups(id) ON DELETE SET NULL,
    
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL, -- Hashed ou Raw (depende da estratégia, aqui guardamos referência segura)
    prefix TEXT NOT NULL,   -- Para exibição (sk_live_...)
    
    -- Overrides individuais (opcional)
    rate_limit INTEGER,
    burst_limit INTEGER,
    scopes TEXT[] DEFAULT '{}',
    
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON system.api_keys (project_slug);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON system.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_groups_project ON system.api_key_groups (project_slug);

-- Migração de Legado (Se houver rate limits antigos)
ALTER TABLE system.rate_limits
ADD COLUMN IF NOT EXISTS rate_limit_auth INTEGER,
ADD COLUMN IF NOT EXISTS burst_limit_auth INTEGER,
ADD COLUMN IF NOT EXISTS rate_limit_anon INTEGER,
ADD COLUMN IF NOT EXISTS burst_limit_anon INTEGER;

UPDATE system.rate_limits 
SET rate_limit_anon = rate_limit, 
    burst_limit_anon = burst_limit,
    rate_limit_auth = rate_limit * 2, 
    burst_limit_auth = burst_limit * 2
WHERE rate_limit_anon IS NULL;
