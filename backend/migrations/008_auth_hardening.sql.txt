
-- Hardening da tabela de OTPs para suportar o fluxo "Ciclo de Vida Fechado"

DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'otp_codes') THEN
        
        ALTER TABLE auth.otp_codes 
        ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS ip_address TEXT;

        -- Index para limpeza rápida de expirados
        CREATE INDEX IF NOT EXISTS idx_otp_codes_expires ON auth.otp_codes (expires_at);

    END IF;
END $$;
