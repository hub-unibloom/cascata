
-- Adiciona coluna de índice para busca segura (Bcrypt não permite busca direta)
-- Estratégia: sk_live_<UUID>_<RANDOM>
-- lookup_index armazena: sk_live_<UUID>
-- key_hash armazena: bcrypt(sk_live_<UUID>_<RANDOM>)

ALTER TABLE system.api_keys
ADD COLUMN IF NOT EXISTS lookup_index TEXT;

-- Índice para performance extrema na validação (Substitui a busca por key_hash nas novas chaves)
CREATE INDEX IF NOT EXISTS idx_api_keys_lookup ON system.api_keys (lookup_index);

-- Comentário de segurança
COMMENT ON COLUMN system.api_keys.lookup_index IS 'Parte não-secreta da chave usada para localização rápida antes da validação do hash Bcrypt.';
