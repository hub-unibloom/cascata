
-- TELEMETRIA DE DADOS (DATA GRAVITY)
-- Objetivo: Detectar exfiltração de dados monitorando o tamanho das respostas.

ALTER TABLE system.api_logs 
ADD COLUMN IF NOT EXISTS response_size INTEGER DEFAULT 0;

-- Índice para encontrar requisições massivas rapidamente
CREATE INDEX IF NOT EXISTS idx_logs_response_size ON system.api_logs (response_size DESC);
