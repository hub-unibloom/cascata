-- Row Level Security (RLS) Atomic Blindagem
-- Forces RLS on all public tables to prevent owner bypass and ensures security audit.
-- Part of "The Holy Grail" Architecture.

DO $$
DECLARE
    row_record RECORD;
BEGIN
    -- For each user table in the public schema
    FOR row_record IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
    LOOP
        -- Check if RLS is intentionally enabled for this table
        DECLARE
            is_rls_active BOOLEAN;
        BEGIN
            SELECT relrowsecurity INTO is_rls_active 
            FROM pg_class 
            JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace 
            WHERE nspname = 'public' AND relname = row_record.tablename;

            IF is_rls_active THEN
                -- 1. Ensure RLS is enabled (should already be)
                EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', row_record.tablename);
                
                -- 2. FORCE RLS (Ensures owner is also checked)
                -- Without this, the backend (as owner) bypasses all security policies.
                EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', row_record.tablename);
                
                RAISE NOTICE 'RLS Forced Blindagem applied to table: %', row_record.tablename;
            ELSE
                RAISE NOTICE 'Skipping RLS Blindagem for disabled table: %', row_record.tablename;
            END IF;
        END;
    END LOOP;
END $$;
