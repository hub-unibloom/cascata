
-- Tabela do Cofre de Segredos (Hierárquica e Criptografada)
CREATE TABLE IF NOT EXISTS system.project_secrets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    parent_id UUID REFERENCES system.project_secrets(id) ON DELETE CASCADE, -- Suporte a pastas aninhadas
    
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'folder', 'cert', 'key', 'env', 'file'
    description TEXT,
    
    -- O valor é armazenado criptografado. NULL se for pasta.
    secret_value TEXT, 
    
    metadata JSONB DEFAULT '{}'::jsonb, -- Ex: { "expiration": "2025-01-01", "provider": "aws" }
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Garante nomes únicos dentro da mesma pasta
    UNIQUE(project_slug, parent_id, name)
);

CREATE INDEX IF NOT EXISTS idx_secrets_parent ON system.project_secrets (project_slug, parent_id);
