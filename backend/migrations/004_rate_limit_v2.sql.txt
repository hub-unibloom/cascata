
-- Adiciona suporte a janelas de tempo personalizadas e mensagens customizadas
ALTER TABLE system.rate_limits 
ADD COLUMN IF NOT EXISTS window_seconds INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS message_anon TEXT,
ADD COLUMN IF NOT EXISTS message_auth TEXT;
