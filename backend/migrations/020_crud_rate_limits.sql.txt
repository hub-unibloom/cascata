
-- Adiciona suporte para limites granulares CRUD na regra global
ALTER TABLE system.rate_limits
ADD COLUMN IF NOT EXISTS crud_limits JSONB DEFAULT '{}'::jsonb;

-- Adiciona suporte para configuração específica de GRUPOS dentro de uma REGRA
-- Isso permite que a regra "/rpc/comprar" tenha limites diferentes para o Grupo "Gold" e "Free"
ALTER TABLE system.rate_limits
ADD COLUMN IF NOT EXISTS group_limits JSONB DEFAULT '{}'::jsonb;

-- Adiciona suporte para limites CRUD nos Grupos (Defaults)
ALTER TABLE system.api_key_groups
ADD COLUMN IF NOT EXISTS crud_limits JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS scopes TEXT[] DEFAULT '{}'; 

COMMENT ON COLUMN system.rate_limits.group_limits IS 'Map: { "uuid_do_grupo": { "rate": 100, "burst": 200, "crud": {...} } }';
