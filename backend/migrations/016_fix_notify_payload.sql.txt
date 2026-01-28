
-- Correção Crítica de Estabilidade: Payload Blowout
-- O pg_notify tem limite hardcoded de 8000 bytes.
-- Enviar a linha inteira (row_to_json) causa falha na transação se o dado for grande.
-- Esta versão envia apenas o ID. O RealtimeService deve buscar os dados (Hydration).

CREATE OR REPLACE FUNCTION public.notify_changes()
RETURNS trigger AS $$
DECLARE
    record_id text;
BEGIN
    BEGIN
        IF (TG_OP = 'DELETE') THEN
            record_id := OLD.id::text;
        ELSE
            record_id := NEW.id::text;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        record_id := 'unknown';
    END;

    -- Payload leve (Safe Payload)
    PERFORM pg_notify(
        'cascata_events',
        json_build_object(
            'table', TG_TABLE_NAME,
            'schema', TG_TABLE_SCHEMA,
            'action', TG_OP,
            'record_id', record_id,
            'timestamp', now()
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
