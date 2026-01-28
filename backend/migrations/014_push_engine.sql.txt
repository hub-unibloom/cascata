
-- Tabela de Regras de Notificação (O Cérebro - Global no System DB)
-- Define gatilhos automáticos baseados em eventos do banco
CREATE TABLE IF NOT EXISTS system.notification_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL REFERENCES system.projects(slug) ON DELETE CASCADE,
    name TEXT NOT NULL,
    active BOOLEAN DEFAULT true,
    
    -- Gatilho
    trigger_table TEXT NOT NULL, -- Ex: 'orders'
    trigger_event TEXT NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE', 'ALL'
    
    -- Lógica (Filtro simples simulado no backend)
    conditions JSONB DEFAULT '[]', -- Ex: [{"field": "status", "op": "eq", "value": "shipped"}]
    
    -- Destino
    recipient_column TEXT NOT NULL, -- Coluna na tabela gatilho que contém o user_id. Ex: 'customer_id'
    
    -- Conteúdo
    title_template TEXT NOT NULL, -- Ex: "Pedido {{id}} Atualizado"
    body_template TEXT NOT NULL,  -- Ex: "Seu pedido agora está: {{status}}"
    data_payload JSONB DEFAULT '{}', -- Dados invisíveis para o app tratar
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_rules_project ON system.notification_rules(project_slug, trigger_table);

-- Histórico de Envios (Auditoria - Global no System DB)
CREATE TABLE IF NOT EXISTS system.notification_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL,
    user_id UUID, 
    status TEXT NOT NULL, -- 'queued', 'sent', 'partial', 'failed'
    provider_response JSONB, 
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_history_project ON system.notification_history(project_slug, created_at DESC);
