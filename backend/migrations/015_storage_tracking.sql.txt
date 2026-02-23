
-- Tabela de Metadados de Storage (Indexação para Performance)
-- O arquivo físico continua no disco/S3. Esta tabela serve apenas para listagem rápida (Grid View).

CREATE TABLE IF NOT EXISTS system.storage_objects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    bucket TEXT NOT NULL,
    
    -- Caminho Virtual
    name TEXT NOT NULL, -- Ex: "foto.jpg"
    parent_path TEXT NOT NULL DEFAULT '', -- Ex: "fotos/2024" (vazio para raiz)
    full_path TEXT NOT NULL, -- Ex: "fotos/2024/foto.jpg"
    is_folder BOOLEAN DEFAULT false,
    
    -- Metadados Físicos
    size BIGINT DEFAULT 0,
    mime_type TEXT,
    provider TEXT DEFAULT 'local', -- 'local', 's3', 'gdrive', etc.
    external_id TEXT, -- ID no provider externo (se houver)
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(project_slug, bucket, full_path)
);

-- Índices para navegação ultra-rápida (substitui o fs.readdir)
CREATE INDEX IF NOT EXISTS idx_storage_parent ON system.storage_objects (project_slug, bucket, parent_path);
CREATE INDEX IF NOT EXISTS idx_storage_search ON system.storage_objects (project_slug, name text_pattern_ops);
