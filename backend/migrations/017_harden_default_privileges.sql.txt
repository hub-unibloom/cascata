
-- SECURE BY DEFAULT: Hardening de Permissões (v3.5 Fixed)
-- Esta migração garante que tabelas NOVAS e EXISTENTES não sejam públicas.

-- 1. Configurar Defaults para Futuras Tabelas
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;

-- 2. Retroatividade: Revogar permissões de tabelas JÁ CRIADAS
DO $$
DECLARE
    r RECORD;
    proc RECORD;
BEGIN
    -- Revoga de Tabelas
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'REVOKE ALL ON TABLE public.' || quote_ident(r.tablename) || ' FROM anon';
        EXECUTE 'REVOKE ALL ON TABLE public.' || quote_ident(r.tablename) || ' FROM authenticated';
    END LOOP;

    -- Revoga de Sequências
    FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public') LOOP
        EXECUTE 'REVOKE ALL ON SEQUENCE public.' || quote_ident(r.sequence_name) || ' FROM anon';
        EXECUTE 'REVOKE ALL ON SEQUENCE public.' || quote_ident(r.sequence_name) || ' FROM authenticated';
    END LOOP;
    
    -- Revoga de Funções (Safe against Overloads using OID)
    FOR proc IN (
        SELECT oid::regprocedure::text as sig 
        FROM pg_proc 
        WHERE pronamespace = 'public'::regnamespace
    ) LOOP
        -- Pula funções críticas de crypto se necessário, mas idealmente todas devem ser fechadas e abertas via GRANT específico
        IF proc.sig NOT LIKE '%uuid_%' AND proc.sig NOT LIKE '%pgp_%' THEN
            EXECUTE 'REVOKE ALL ON FUNCTION ' || proc.sig || ' FROM anon';
            EXECUTE 'REVOKE ALL ON FUNCTION ' || proc.sig || ' FROM authenticated';
        END IF;
    END LOOP;
END $$;
