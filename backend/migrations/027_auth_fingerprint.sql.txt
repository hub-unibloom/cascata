
-- Security Hardening: Session Fingerprinting
-- Adiciona colunas para vincular o token à origem física e ao dispositivo

DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'refresh_tokens') THEN
        
        ALTER TABLE auth.refresh_tokens 
        ADD COLUMN IF NOT EXISTS user_agent TEXT,
        ADD COLUMN IF NOT EXISTS ip_address TEXT;

        -- Índice para análise forense e bloqueio rápido por IP
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_ip ON auth.refresh_tokens (ip_address);

    END IF;
END $$;
