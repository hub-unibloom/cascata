
-- Tabela de Políticas de Backup
-- Armazena a configuração de agendamento e credenciais.
-- O campo 'config' é sensível (contém a Service Account Key do Google) e DEVE ser tratado com cuidado.

CREATE TABLE IF NOT EXISTS system.backup_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    name TEXT NOT NULL,
    provider TEXT NOT NULL, -- 'gdrive', 's3' (futuro)
    schedule_cron TEXT NOT NULL, -- Ex: '0 3 * * *' (Todo dia as 3am)
    config JSONB NOT NULL, -- Armazena credentials criptografadas na aplicação ou aqui (vamos criptografar via App para flexibilidade)
    retention_count INTEGER DEFAULT 7, -- Quantos backups manter
    is_active BOOLEAN DEFAULT true,
    last_run_at TIMESTAMP WITH TIME ZONE,
    last_status TEXT, -- 'success', 'failed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_policies_project ON system.backup_policies(project_slug);

-- Histórico de Execução
CREATE TABLE IF NOT EXISTS system.backup_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    policy_id UUID REFERENCES system.backup_policies(id) ON DELETE SET NULL,
    project_slug TEXT NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    finished_at TIMESTAMP WITH TIME ZONE,
    status TEXT NOT NULL, -- 'running', 'completed', 'failed'
    file_size BIGINT,
    file_name TEXT,
    external_id TEXT, -- ID do arquivo no Google Drive
    logs TEXT, -- Captura de erro resumida
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_history_policy ON system.backup_history(policy_id);
