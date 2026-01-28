
-- Tabela para armazenar regras de Rate Limit por rota/recurso
CREATE TABLE IF NOT EXISTS system.rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    route_pattern TEXT NOT NULL, -- Ex: "/tables/users" ou "/rpc/*"
    method TEXT DEFAULT 'ALL', -- GET, POST, DELETE, etc.
    rate_limit INTEGER NOT NULL DEFAULT 10, -- Requisições por segundo (r/s)
    burst_limit INTEGER NOT NULL DEFAULT 5, -- Capacidade de explosão (burst)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_slug, route_pattern, method)
);

-- Índice para recuperação rápida durante a geração de configuração do Nginx
CREATE INDEX IF NOT EXISTS idx_rate_limits_config ON system.rate_limits (project_slug);
