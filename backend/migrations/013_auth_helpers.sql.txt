
-- Funções auxiliares para RLS (Emulação do ambiente Supabase/PostgREST)
-- Safe wrapper para evitar erro se schema 'auth' não existir (ex: no system db)

DO $$ 
BEGIN 
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth') THEN

    -- auth.uid()
    -- Retorna o ID do usuário logado (do JWT) ou NULL
    CREATE OR REPLACE FUNCTION auth.uid() 
    RETURNS uuid 
    LANGUAGE sql 
    STABLE 
    AS $f$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $f$;

    -- auth.role()
    -- Retorna a role do usuário (ex: 'authenticated', 'anon')
    CREATE OR REPLACE FUNCTION auth.role() 
    RETURNS text 
    LANGUAGE sql 
    STABLE 
    AS $f$
      SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')::text;
    $f$;

    -- auth.email()
    -- Retorna o email do usuário (se estiver no JWT)
    CREATE OR REPLACE FUNCTION auth.email() 
    RETURNS text 
    LANGUAGE sql 
    STABLE 
    AS $f$
      SELECT NULLIF(current_setting('request.jwt.claim.email', true), '')::text;
    $f$;

    -- Permissões
    GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
    GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;
    GRANT EXECUTE ON FUNCTION auth.email() TO PUBLIC;

  END IF;
END $$;
