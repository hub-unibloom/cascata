
-- Adiciona configurações avançadas de resposta e punição nos grupos
ALTER TABLE system.api_key_groups
ADD COLUMN IF NOT EXISTS rejection_message TEXT,
ADD COLUMN IF NOT EXISTS nerf_config JSONB DEFAULT '{
    "enabled": false,
    "start_delay_seconds": 0,
    "mode": "speed", 
    "stop_after_seconds": -1
}'::jsonb;

-- Comentários para clareza
COMMENT ON COLUMN system.api_key_groups.nerf_config IS 'Configuração de comportamento pós-vencimento: { enabled, start_delay_seconds, mode: "speed"|"quota", stop_after_seconds (-1 = never) }';
