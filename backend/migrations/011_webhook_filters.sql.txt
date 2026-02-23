
-- Adiciona coluna de filtros para lógica condicional (No-Code Rules)
ALTER TABLE system.webhooks 
ADD COLUMN IF NOT EXISTS filters JSONB DEFAULT '[]'::jsonb;

-- Comentário para documentação do schema interno
COMMENT ON COLUMN system.webhooks.filters IS 'Lista de condições lógicas (AND) para disparar o webhook. Ex: [{"field": "status", "op": "=", "value": "paid"}]';
