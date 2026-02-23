
-- OTIMIZAÇÃO DE PERFORMANCE ENTERPRISE
-- Data: Imediata
-- Objetivo: Eliminar Sequential Scans em tabelas de alta cardinalidade (Logs)

-- 1. Índice Composto para Logs (Filtragem por Projeto + Data)
-- Permite que o dashboard carregue instantaneamente mesmo com milhões de linhas,
-- e que a exportação de backup use Index Scan.
-- NOTA: CONCURRENTLY removido pois migrations rodam em bloco BEGIN/COMMIT
CREATE INDEX IF NOT EXISTS idx_logs_composite 
ON system.api_logs (project_slug, created_at DESC);

-- 2. Índice para Auditoria de Segurança (Busca por IP)
-- Acelera a verificação de blocklist e análise forense de IPs suspeitos.
CREATE INDEX IF NOT EXISTS idx_logs_client_ip 
ON system.api_logs (client_ip, created_at DESC);

-- 3. Vacuum Analyze para atualizar estatísticas imediatamente
ANALYZE system.api_logs;
