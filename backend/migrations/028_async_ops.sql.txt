
-- Tabela para rastrear operações longas (Async Jobs)
-- Usada para evitar DoS na API principal durante Imports/Exports pesados

CREATE TABLE IF NOT EXISTS system.async_operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT, -- Pode ser null se for uma criação nova
    type TEXT NOT NULL, -- 'import', 'export'
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    metadata JSONB DEFAULT '{}', -- Dados extras (ex: nome do arquivo)
    result JSONB, -- Resultado final ou mensagem de erro
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_async_ops_status ON system.async_operations (status);
