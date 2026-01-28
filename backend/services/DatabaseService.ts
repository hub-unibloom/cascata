
import { PoolClient, Client, Pool } from 'pg';

export class DatabaseService {
    /**
     * Initializes the standard Cascata database structure for a project.
     */
    public static async initProjectDb(client: PoolClient | Client) {
        console.log('[DatabaseService] Initializing project structure (Push Engine Enabled)...');
        
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
                raw_user_meta_data JSONB DEFAULT '{}',
                confirmation_token TEXT,
                confirmation_sent_at TIMESTAMPTZ,
                recovery_token TEXT,
                recovery_sent_at TIMESTAMPTZ,
                email_change_token_new TEXT,
                email_change TEXT,
                email_change_sent_at TIMESTAMPTZ,
                email_confirmed_at TIMESTAMPTZ
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

            -- Auth Tables: User Devices (PUSH ENGINE)
            CREATE TABLE IF NOT EXISTS auth.user_devices (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
                token TEXT NOT NULL, -- FCM Token
                platform TEXT CHECK (platform IN ('ios', 'android', 'web', 'other')),
                app_version TEXT,
                meta JSONB DEFAULT '{}',
                is_active BOOLEAN DEFAULT true,
                last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(user_id, token)
            );

            CREATE INDEX IF NOT EXISTS idx_user_devices_user ON auth.user_devices(user_id);
            CREATE INDEX IF NOT EXISTS idx_user_devices_token ON auth.user_devices(token);

            -- Auth Tables: Refresh Tokens
            CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                token_hash TEXT NOT NULL,
                user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
                revoked BOOLEAN DEFAULT false,
                created_at TIMESTAMPTZ DEFAULT now(),
                expires_at TIMESTAMPTZ NOT NULL,
                parent_token UUID REFERENCES auth.refresh_tokens(id)
            );

            -- Auth Tables: OTP Codes
            CREATE TABLE IF NOT EXISTS auth.otp_codes (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                identifier TEXT NOT NULL,
                provider TEXT NOT NULL,
                code TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now(),
                attempts INTEGER DEFAULT 0,
                metadata JSONB DEFAULT '{}',
                ip_address TEXT
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
                ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
            END $$;
        `);
        
        // TRIGGER NOTIFY (FIXED: Payload Blowout Protection)
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

                -- Anti-Suicide Fix: Send only metadata, hydrate later.
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
    }

    public static async validateTableDefinition(pool: Pool, tableName: string, columns: any[]) {
        const client = await pool.connect();
        try {
            const checkTable = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1", [tableName]);
            if (checkTable.rowCount && checkTable.rowCount > 0) throw new Error(`Table "${tableName}" already exists.`);
        } finally { client.release(); }
    }
}
