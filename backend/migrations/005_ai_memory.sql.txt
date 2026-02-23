
-- Histórico de conversas com o Arquiteto (Contexto de Longo Prazo)
CREATE TABLE IF NOT EXISTS system.ai_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    session_id TEXT NOT NULL, -- Para agrupar mensagens de uma mesma "thread"
    role TEXT NOT NULL, -- 'user' ou 'assistant'
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}', -- Para guardar tokens usados, modelo, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_history_project ON system.ai_history (project_slug, session_id);

-- Documentação Manual/Híbrida (Para a aba Docs)
CREATE TABLE IF NOT EXISTS system.doc_pages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    slug TEXT NOT NULL, -- ex: 'getting-started', 'auth-guide'
    title TEXT NOT NULL,
    content_markdown TEXT,
    is_public BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_slug, slug)
);
