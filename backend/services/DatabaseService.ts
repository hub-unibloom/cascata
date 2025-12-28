
import { PoolClient, Client, Pool } from 'pg';

export class DatabaseService {
    /**
     * Initializes the standard Cascata database structure.
     */
    public static async initProjectDb(client: PoolClient | Client) {
        console.log('[DatabaseService] Initializing project structure (Production Mode)...');
        
        await client.query(`
            -- Extensions
            CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
            CREATE EXTENSION IF NOT EXISTS "pgcrypto";
            
            -- Schemas
            CREATE SCHEMA IF NOT EXISTS auth;
            
            -- Auth Tables: Users
            CREATE TABLE IF NOT EXISTS auth.users (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                created_at TIMESTAMPTZ DEFAULT now(),
                last_sign_in_at TIMESTAMPTZ,
                banned BOOLEAN DEFAULT false,
                raw_user_meta_data JSONB DEFAULT '{}'
            );

            -- Auth Tables: Identities
            CREATE TABLE IF NOT EXISTS auth.identities (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
                provider TEXT NOT NULL,
                identifier TEXT NOT NULL,
                password_hash TEXT,
                identity_data JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT now(),
                last_sign_in_at TIMESTAMPTZ,
                UNIQUE(provider, identifier)
            );

            -- Auth Tables: Refresh Tokens (Session Management)
            CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                token_hash TEXT NOT NULL,
                user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
                revoked BOOLEAN DEFAULT false,
                created_at TIMESTAMPTZ DEFAULT now(),
                expires_at TIMESTAMPTZ NOT NULL,
                parent_token UUID REFERENCES auth.refresh_tokens(id)
            );
            CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON auth.refresh_tokens(token_hash);
            CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON auth.refresh_tokens(user_id);

            -- Auth Tables: OTP Codes (Passwordless)
            CREATE TABLE IF NOT EXISTS auth.otp_codes (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                identifier TEXT NOT NULL,
                provider TEXT NOT NULL,
                code TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now()
            );

            -- SECURITY HARDENING: Roles & Privileges
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
                IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
                IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
                
                IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cascata_api_role') THEN 
                    CREATE ROLE cascata_api_role NOLOGIN; 
                END IF;

                GRANT anon TO cascata_api_role;
                GRANT authenticated TO cascata_api_role;
                GRANT service_role TO cascata_api_role;

                GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, cascata_api_role;
                GRANT USAGE ON SCHEMA auth TO service_role, cascata_api_role;
                
                GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
                GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
                
                GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
                GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

                ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
                ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
                ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
            END $$;
        `);
        
        await client.query(`
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
        `);
        
        console.log('[DatabaseService] Initialization complete.');
    }

    /**
     * Validates a new table definition BEFORE creating it.
     * Prevents invalid SQL states like referencing non-unique columns.
     */
    public static async validateTableDefinition(pool: Pool, tableName: string, columns: any[]) {
        const client = await pool.connect();
        try {
            // 1. Check if table exists
            const checkTable = await client.query(
                "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
                [tableName]
            );
            if (checkTable.rowCount && checkTable.rowCount > 0) {
                throw new Error(`Table "${tableName}" already exists.`);
            }

            // 2. Validate Foreign Keys
            for (const col of columns) {
                if (col.foreignKey) {
                    const { table: targetTable, column: targetCol } = col.foreignKey;
                    
                    // Check if target table exists
                    const checkTarget = await client.query(
                        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
                        [targetTable]
                    );
                    if (!checkTarget.rowCount || checkTarget.rowCount === 0) {
                        throw new Error(`Foreign Key Error: Target table "${targetTable}" does not exist.`);
                    }

                    // Check if target column is UNIQUE or PRIMARY KEY
                    // Postgres constraint: "referenced table must have a unique constraint on the referenced column(s)"
                    const checkUnique = await client.query(`
                        SELECT 1 
                        FROM information_schema.table_constraints tc 
                        JOIN information_schema.constraint_column_usage ccu 
                        ON tc.constraint_name = ccu.constraint_name 
                        WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE') 
                        AND tc.table_name = $1 
                        AND ccu.column_name = $2
                    `, [targetTable, targetCol]);

                    if (!checkUnique.rowCount || checkUnique.rowCount === 0) {
                        throw new Error(`Foreign Key Error: Column "${targetCol}" in table "${targetTable}" is not a Primary Key or Unique. Relations must point to unique fields.`);
                    }
                }
            }
        } finally {
            client.release();
        }
    }
}
