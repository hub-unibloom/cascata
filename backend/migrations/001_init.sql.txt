
-- Schema do Sistema (Control Plane)
CREATE SCHEMA IF NOT EXISTS system;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tabela de Projetos
CREATE TABLE IF NOT EXISTS system.projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'healthy',
    db_name TEXT UNIQUE NOT NULL, 
    custom_domain TEXT UNIQUE,
    default_domain TEXT UNIQUE,
    ssl_certificate_source TEXT, -- Permite vincular certificados de outros dominios
    jwt_secret TEXT NOT NULL,
    anon_key TEXT NOT NULL,
    service_key TEXT NOT NULL,
    blocklist TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    log_retention_days INTEGER DEFAULT 30,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ASSETS: RPC, Triggers, Cron e Folders
CREATE TABLE IF NOT EXISTS system.assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'rpc', 'trigger', 'cron', 'folder'
    parent_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- WEBHOOKS
CREATE TABLE IF NOT EXISTS system.webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL,
    target_url TEXT NOT NULL,
    event_type TEXT NOT NULL,
    table_name TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    secret_header TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- AUDIT LOGS ENRIQUECIDOS
CREATE TABLE IF NOT EXISTS system.api_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER,
    client_ip TEXT,
    duration_ms INTEGER,
    user_role TEXT,
    payload JSONB,
    headers JSONB,
    user_agent TEXT,
    geo_info JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Configurações de UI
CREATE TABLE IF NOT EXISTS system.ui_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL,
    table_name TEXT NOT NULL,
    settings JSONB NOT NULL,
    UNIQUE(project_slug, table_name)
);

-- Administradores
CREATE TABLE IF NOT EXISTS system.admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- SEED SEGURO: Senha nasce hashada (Bcrypt) via pgcrypto
INSERT INTO system.admin_users (email, password_hash) 
SELECT 'admin@cascata.io', crypt('admin123', gen_salt('bf'))
WHERE NOT EXISTS (SELECT 1 FROM system.admin_users WHERE email = 'admin@cascata.io');
