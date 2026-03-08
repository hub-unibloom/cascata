
-- Tabela para gerenciar metadados das sessões de IA (Títulos, Datas)
CREATE TABLE IF NOT EXISTS system.ai_sessions (
    id UUID PRIMARY KEY, -- ID gerado pelo frontend ou backend
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    title TEXT DEFAULT 'Nova Conversa',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index para listar sessões de um projeto rapidamente
CREATE INDEX IF NOT EXISTS idx_ai_sessions_project ON system.ai_sessions (project_slug, updated_at DESC);
