
-- Tabela para Histórico de Versões de Assets (Time Travel)
CREATE TABLE IF NOT EXISTS system.asset_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id UUID NOT NULL REFERENCES system.assets(id) ON DELETE CASCADE,
    project_slug TEXT NOT NULL,
    content TEXT NOT NULL, -- O código SQL ou JS
    metadata JSONB DEFAULT '{}', -- Configs extras (env vars, schedule)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT -- Identificador do usuário que salvou (se disponível)
);

CREATE INDEX IF NOT EXISTS idx_asset_history_asset ON system.asset_history (asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_history_project ON system.asset_history (project_slug);
