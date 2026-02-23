
-- Adiciona colunas para fluxo de confirmação de e-mail

DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users') THEN

        ALTER TABLE auth.users 
        ADD COLUMN IF NOT EXISTS confirmation_token TEXT,
        ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS recovery_token TEXT,
        ADD COLUMN IF NOT EXISTS recovery_sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS email_change_token_new TEXT,
        ADD COLUMN IF NOT EXISTS email_change TEXT,
        ADD COLUMN IF NOT EXISTS email_change_sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;

        -- Índices para busca rápida de tokens
        CREATE INDEX IF NOT EXISTS idx_users_confirmation_token ON auth.users (confirmation_token);
        CREATE INDEX IF NOT EXISTS idx_users_recovery_token ON auth.users (recovery_token);
    
    END IF;
END $$;
