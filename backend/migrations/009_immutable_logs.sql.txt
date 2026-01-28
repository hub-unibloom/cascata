
-- 1. Função de Trigger para garantir Imutabilidade
-- Bloqueia UPDATE incondicionalmente.
-- Bloqueia DELETE a menos que esteja em modo de manutenção segura.
CREATE OR REPLACE FUNCTION system.enforce_log_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'UPDATE') THEN
        RAISE EXCEPTION 'Security Alert: Audit logs are immutable. Updates are not allowed.';
    ELSIF (TG_OP = 'DELETE') THEN
        -- Verifica se a flag de manutenção está ativa na sessão atual
        IF current_setting('cascata.maintenance_mode', true) <> 'true' THEN
            RAISE EXCEPTION 'Security Alert: Audit logs cannot be deleted manually. Use system.purge_old_logs().';
        END IF;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- 2. Aplicação do Trigger na tabela de logs
DROP TRIGGER IF EXISTS trg_immutable_logs ON system.api_logs;

CREATE TRIGGER trg_immutable_logs
BEFORE UPDATE OR DELETE ON system.api_logs
FOR EACH ROW EXECUTE FUNCTION system.enforce_log_immutability();

-- 3. Função Segura de Purge (Retention Policy)
-- Esta é a ÚNICA maneira autorizada de deletar logs.
-- Ela ativa a flag de manutenção, deleta logs antigos e retorna a contagem.
CREATE OR REPLACE FUNCTION system.purge_old_logs(p_slug TEXT, p_days INTEGER)
RETURNS INTEGER AS $$
DECLARE
    count INTEGER;
BEGIN
    -- Ativa modo de manutenção apenas para esta transação
    PERFORM set_config('cascata.maintenance_mode', 'true', true);
    
    WITH deleted AS (
        DELETE FROM system.api_logs 
        WHERE project_slug = p_slug 
        AND created_at < NOW() - (p_days || ' days')::INTERVAL
        RETURNING id
    )
    SELECT count(*) INTO count FROM deleted;
    
    RETURN count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
