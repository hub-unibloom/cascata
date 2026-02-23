
-- Adiciona configurações de confiabilidade e alerta
ALTER TABLE system.webhooks 
ADD COLUMN IF NOT EXISTS fallback_url TEXT,
ADD COLUMN IF NOT EXISTS retry_policy TEXT DEFAULT 'standard'; -- 'standard' (exp), 'none' (critical), 'linear'

-- Comentários para documentação
COMMENT ON COLUMN system.webhooks.fallback_url IS 'URL disparada apenas se o envio principal falhar todas as tentativas (Dead Letter).';
COMMENT ON COLUMN system.webhooks.retry_policy IS 'Estratégia de retentativa: standard (10x exp), none (1x - evita duplicidade), linear (5x fixed).';
