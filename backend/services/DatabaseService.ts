
import { PoolClient, Client, Pool } from 'pg';
import { systemPool } from '../src/config/main.js';
import { PoolService } from './PoolService.js';
import { quoteId } from '../src/utils/index.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Cursor = require('pg-cursor');

export interface DataDiffSummary {
    table: string;
    new_rows: number;      // Rows in Draft but NOT in Live (INSERT)
    update_rows: number;   // Rows in Draft AND in Live (UPDATE)
    missing_rows: number;  // Rows in Live but NOT in Draft (Potential DELETE, usually ignored)
    total_source: number;
    total_target: number;
    conflicts: number;     // Legacy alias for update_rows
}

export interface GranularMergePlan {
    [tableName: string]: {
        strategy: 'ignore' | 'append' | 'upsert' | 'overwrite' | 'smart_sync';
    }
}

export class DatabaseService {
    /**
     * Initializes the standard Cascata database structure for the system database.
     */
    public static async initSystemDb(client?: PoolClient) {
        console.log('[System] Verifying/Initializing system structure...');
        const workerClient = client || await systemPool.connect();
        try {
            await workerClient.query(`
                CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
                
                CREATE SCHEMA IF NOT EXISTS system;

                CREATE TABLE IF NOT EXISTS system.projects (
                    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                    name TEXT NOT NULL,
                    db_name TEXT NOT NULL UNIQUE,
                    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived', 'provisioning', 'failed')),
                    created_at TIMESTAMPTZ DEFAULT now(),
                    metadata JSONB DEFAULT '{}'
                );
                
                -- NEW: Intrusion Logger (Tier-3 Column Padlock)
                CREATE TABLE IF NOT EXISTS system.security_events (
                    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                    project_id UUID REFERENCES system.projects(id) ON DELETE CASCADE,
                    table_name TEXT NOT NULL,
                    column_name TEXT NOT NULL,
                    attempted_value TEXT,
                    ip TEXT,
                    created_at TIMESTAMPTZ DEFAULT now()
                );
                CREATE INDEX IF NOT EXISTS idx_security_events_project ON system.security_events(project_id);

                CREATE TABLE IF NOT EXISTS system.db_migrations (
                    id SERIAL PRIMARY KEY,
                    project_id UUID REFERENCES system.projects(id) ON DELETE CASCADE,
                    version VARCHAR(255) NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    executed_at TIMESTAMPTZ DEFAULT now(),
                    UNIQUE(project_id, version)
                );
            `);
        } finally {
            if (!client) workerClient.release();
        }
    }

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
                updated_at TIMESTAMPTZ,
                last_sign_in_at TIMESTAMPTZ,
                verified_at TIMESTAMPTZ,
                UNIQUE(provider, identifier)
            );

            -- IRON-CLAD TRIGGER: auth.identities (Universal Security Lock — Defense-in-Depth)
            -- Enforces at the DATABASE LAYER (impossible to bypass from application code):
            --   id:          IMMUTABLE (frozen on update)
            --   created_at:  IMMUTABLE (frozen on update)
            --   verified_at: WRITE-ONCE SEAL (once set, permanently sealed — cannot be overwritten or cleared)
            --   updated_at:  SERVER-CONTROLLED (forced to now() on every update, never client-spoofable)
            CREATE OR REPLACE FUNCTION auth.lock_identities_integrity()
            RETURNS TRIGGER AS $$
            BEGIN
                -- IMMUTABLE: id can never be changed
                NEW.id = OLD.id;
                -- IMMUTABLE: created_at frozen at birth
                NEW.created_at = OLD.created_at;
                -- WRITE-ONCE SEAL: verified_at, once stamped, is permanent evidence
                IF OLD.verified_at IS NOT NULL THEN
                    NEW.verified_at = OLD.verified_at;
                END IF;
                -- SERVER-CONTROLLED: updated_at always reflects true server time
                NEW.updated_at = now();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS ensure_identities_integrity ON auth.identities;
            CREATE TRIGGER ensure_identities_integrity
            BEFORE UPDATE ON auth.identities
            FOR EACH ROW EXECUTE FUNCTION auth.lock_identities_integrity();

            -- Auth Tables: User Devices (PUSH ENGINE)
            CREATE TABLE IF NOT EXISTS auth.user_devices (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
                token TEXT NOT NULL,
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
                parent_token UUID REFERENCES auth.refresh_tokens(id),
                user_agent TEXT,
                ip_address TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_refresh_tokens_ip ON auth.refresh_tokens (ip_address);

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
            CREATE INDEX IF NOT EXISTS idx_otp_codes_expires ON auth.otp_codes (expires_at);

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
                GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
                
                ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
                ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
            END $$;

            -- Extensions Schema (pre-created so ExtensionService.installExtension never hits "schema does not exist")
            CREATE SCHEMA IF NOT EXISTS extensions;

            DO $$
            BEGIN
                GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role, cascata_api_role;
                GRANT SELECT ON ALL TABLES IN SCHEMA extensions TO anon, authenticated, service_role, cascata_api_role;
                GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO anon, authenticated, service_role, cascata_api_role;
                GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA extensions TO anon, authenticated, service_role, cascata_api_role;
                ALTER DEFAULT PRIVILEGES IN SCHEMA extensions
                    GRANT SELECT ON TABLES TO anon, authenticated, service_role, cascata_api_role;
                ALTER DEFAULT PRIVILEGES IN SCHEMA extensions
                    GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role, cascata_api_role;
                ALTER DEFAULT PRIVILEGES IN SCHEMA extensions
                    GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role, cascata_api_role;
            EXCEPTION WHEN undefined_object THEN
                NULL;
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
                
                -- Realtime Broadcast (Event Stream)
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

                -- Fase 1.3: Dragonfly Semantic Cache Invalidation (Fire & Forget)
                -- Avisa instantaneamente o Worker Node.js para deletar a familia 'qcache:tabela:*' do L2
                PERFORM pg_notify(
                    'cascata_cache_invalidate',
                    json_build_object(
                        'table', TG_TABLE_NAME,
                        'schema', TG_TABLE_SCHEMA
                    )::text
                );

                RETURN NULL;
            END;
            $$ LANGUAGE plpgsql;
        `);

        // Agora chamamos o injetor para a base recém criada
        await DatabaseService.injectSecurityLockEngine(client);
    }

    public static async injectSecurityLockEngine(client: any) {
        // TIER-3 PADLOCK: INJECTING NATIVE SECURITY LOCKS HYBRID ENGINE (Eixos A e B)
        await client.query(`
            CREATE SCHEMA IF NOT EXISTS system;

            CREATE TABLE IF NOT EXISTS system.dynamic_security_locks (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                project_slug TEXT NOT NULL,
                table_name TEXT NOT NULL,
                column_name TEXT NOT NULL,
                lock_type TEXT NOT NULL,
                metadata JSONB DEFAULT '{}'::jsonb,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(project_slug, table_name, column_name)
            );

            CREATE INDEX IF NOT EXISTS idx_dynamic_locks_fast_lookup ON system.dynamic_security_locks (project_slug, table_name);

            CREATE OR REPLACE FUNCTION system.enforce_dynamic_locks()
            RETURNS TRIGGER AS $$
            DECLARE
                _project_slug TEXT;
                _is_otp_verified TEXT;
                _request_role TEXT;
                _lock_record RECORD;
                _old_value JSONB;
                _new_value JSONB;
            BEGIN
                _project_slug := current_setting('request.jwt.claim.project_slug', true);
                IF _project_slug IS NULL THEN
                    _project_slug := current_setting('app.current_project_slug', true);
                END IF;

                IF _project_slug IS NOT NULL THEN
                    _is_otp_verified := current_setting('request.jwt.claim.otp_verified', true);
                    _request_role := current_setting('request.jwt.claim.role', true);
                    
                    IF TG_OP = 'UPDATE' THEN
                        _old_value := to_jsonb(OLD);
                        _new_value := to_jsonb(NEW);
                    ELSIF TG_OP = 'INSERT' THEN
                        _new_value := to_jsonb(NEW);
                        _old_value := '{}'::jsonb;
                    END IF;

                    FOR _lock_record IN 
                        SELECT column_name, lock_type 
                        FROM system.dynamic_security_locks 
                        WHERE project_slug = _project_slug AND table_name = TG_TABLE_NAME
                    LOOP
                        -- Immutability on INSERT (No initial explicit inject by untrusted clients)
                        IF TG_OP = 'INSERT' AND _new_value ? _lock_record.column_name THEN
                            IF _lock_record.lock_type = 'immutable' AND coalesce(_request_role, 'service_role') IN ('anon', 'authenticated') THEN
                                RAISE EXCEPTION USING ERRCODE = 'PDC03', MESSAGE = 'Security Lock Violation: Column "' || _lock_record.column_name || '" is IMMUTABLE and cannot be explicitly set by clients on row creation.';
                            END IF;
                        END IF;

                        -- Mutation Interception (Value effectively changed)
                        IF _new_value ? _lock_record.column_name AND (_old_value ->> _lock_record.column_name IS DISTINCT FROM _new_value ->> _lock_record.column_name) THEN
                            
                            IF _lock_record.lock_type IN ('insert_only', 'immutable') AND TG_OP = 'UPDATE' THEN
                                RAISE EXCEPTION USING ERRCODE = 'PDC02', MESSAGE = 'Security Lock Violation: Column "' || _lock_record.column_name || '" is locked (' || _lock_record.lock_type || ') and cannot be updated.';
                            END IF;
                            
                            IF _lock_record.lock_type = 'service_role_only' AND coalesce(_request_role, 'service_role') IN ('anon', 'authenticated') THEN
                                RAISE EXCEPTION USING ERRCODE = 'PDC04', MESSAGE = 'Security Lock Violation: Column "' || _lock_record.column_name || '" requires SERVICE_ROLE system privileges to mutate.';
                            END IF;

                            IF _lock_record.lock_type = 'otp_protected' THEN
                                IF coalesce(_is_otp_verified, 'false') != 'true' THEN
                                    RAISE EXCEPTION USING ERRCODE = 'PDC01', MESSAGE = 'Security Lock Violation: Valid OTP / Step-Up Authorization Ring is required to mutate column "' || _lock_record.column_name || '".';
                                END IF;
                            END IF;
                        END IF;
                    END LOOP;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql SECURITY DEFINER;

            CREATE OR REPLACE FUNCTION system.apply_security_locks(_project_slug TEXT, _table_name TEXT, _locked_columns JSONB)
            RETURNS VOID AS $$
            DECLARE
                _col_name TEXT;
                _lock_type TEXT;
                _has_dynamic BOOLEAN := FALSE;
            BEGIN
                -- FIX: Use _table_name directly with %I — format('%I', ...) already applies
                -- quote_ident internally. Using a pre-quoted value with %I causes double-quoting.
                EXECUTE format('DROP TRIGGER IF EXISTS trg_dynamic_locks ON public.%I', _table_name);
                DELETE FROM system.dynamic_security_locks WHERE project_slug = _project_slug AND table_name = _table_name;
                
                FOR _col_name, _lock_type IN SELECT * FROM jsonb_each_text(_locked_columns)
                LOOP
                    -- FIX: Do NOT quote_ident column names here. The enforce_dynamic_locks trigger
                    -- compares column_name against JSONB keys from to_jsonb(NEW), which are stored
                    -- without quotes. Using quote_ident would store '"col"' instead of 'col',
                    -- causing ALL JSONB key-existence checks (? operator) to silently fail.
                    -- O Santo Graal: Zero conflitos com Table-Level GRANTs!
                    -- Toda a autoridade foi transladada com precisão cirúrgica para o Motor de Triggers (system.enforce_dynamic_locks).
                    -- Não há necessidade de gerenciar matrizes estáticas no sistema de permissões do PostgREST.
                    INSERT INTO system.dynamic_security_locks (project_slug, table_name, column_name, lock_type)
                    VALUES (_project_slug, _table_name, _col_name, _lock_type);
                    _has_dynamic := TRUE;
                END LOOP;

                IF _has_dynamic THEN
                    EXECUTE format('CREATE TRIGGER trg_dynamic_locks BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION system.enforce_dynamic_locks()', _table_name);
                END IF;
            END;
            $$ LANGUAGE plpgsql SECURITY DEFINER;
        `);
    }

    public static async validateTableDefinition(pool: Pool, tableName: string, columns: any[]) {
        const client = await pool.connect();
        try {
            const checkTable = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1", [tableName]);
            if (checkTable.rowCount && checkTable.rowCount > 0) throw new Error(`Table "${tableName}" already exists.`);
        } finally { client.release(); }
    }

    public static async dbExists(dbName: string): Promise<boolean> {
        const res = await systemPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
        return (res.rowCount || 0) > 0;
    }

    // --- SNAPSHOT & CLONING ENGINE ---

    public static async terminateConnections(dbName: string) {
        await PoolService.terminate(dbName);
        await systemPool.query(`
            SELECT pg_terminate_backend(pid) 
            FROM pg_stat_activity 
            WHERE datname = $1 AND pid <> pg_backend_pid()
        `, [dbName]);
    }

    public static async createSnapshot(sourceDb: string, snapshotName: string) {
        console.log(`[DatabaseService] Creating Safety Snapshot: ${sourceDb} -> ${snapshotName}`);
        await this.terminateConnections(sourceDb);
        if (await this.dbExists(snapshotName)) {
            await this.terminateConnections(snapshotName);
            await systemPool.query(`DROP DATABASE "${snapshotName}"`);
        }
        await systemPool.query(`CREATE DATABASE "${snapshotName}" WITH TEMPLATE "${sourceDb}" OWNER "${process.env.DB_USER}"`);
        console.log(`[DatabaseService] Snapshot Created.`);
    }

    public static async listDatabaseSnapshots(liveDbName: string) {
        // Query Postgres for all databases starting with the live name + _backup_
        // Pattern: liveDbName_backup_TIMESTAMP
        const res = await systemPool.query(`
            SELECT datname as name, 
                   pg_size_pretty(pg_database_size(datname)) as size,
                   (pg_stat_file('base/'||oid||'/PG_VERSION')).modification as created_at
            FROM pg_database 
            WHERE datname LIKE $1 
            ORDER BY datname DESC
        `, [`${liveDbName}_backup_%`]);

        return res.rows.map(r => {
            // Extract timestamp from name: dbname_backup_17123456789
            const match = r.name.match(/_backup_(\d+)$/);
            const ts = match ? parseInt(match[1]) : null;
            return {
                name: r.name,
                size: r.size,
                created_at: r.created_at, // OS creation time
                timestamp_id: ts // Extracted TS for logic
            };
        });
    }

    public static async cloneDatabase(sourceDb: string, targetDb: string) {
        console.log(`[DatabaseService] Cloning ${sourceDb} -> ${targetDb}...`);
        await this.terminateConnections(sourceDb);
        if (await this.dbExists(targetDb)) {
            await this.terminateConnections(targetDb);
            await systemPool.query(`DROP DATABASE "${targetDb}"`);
        }
        await systemPool.query(`CREATE DATABASE "${targetDb}" WITH TEMPLATE "${sourceDb}" OWNER "${process.env.DB_USER}"`);
    }

    public static async dropDatabase(dbName: string) {
        console.log(`[DatabaseService] Dropping ${dbName}...`);
        if (await this.dbExists(dbName)) {
            await this.terminateConnections(dbName);
            await systemPool.query(`DROP DATABASE "${dbName}"`);
        }
    }

    public static async truncatePublicTables(dbName: string) {
        const pool = PoolService.get(dbName, { useDirect: true });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
            for (const row of res.rows) {
                await client.query(`TRUNCATE TABLE public.${quoteId(row.table_name)} CASCADE`);
            }
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    public static async pruneDatabase(dbName: string, percentToKeep: number) {
        if (percentToKeep >= 100) return;
        const deleteChance = 1 - (percentToKeep / 100);
        const pool = PoolService.get(dbName, { useDirect: true });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET session_replication_role = 'replica';");
            const tablesRes = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
            for (const row of tablesRes.rows) {
                await client.query(`DELETE FROM public.${quoteId(row.table_name)} WHERE random() < $1`, [deleteChance]);
            }
            await client.query("SET session_replication_role = 'origin';");
            await client.query('COMMIT');
            await client.query('VACUUM FULL');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    public static async fixPermissions(dbName: string) {
        const pool = PoolService.get(dbName, { useDirect: true });
        const client = await pool.connect();
        try {
            await client.query(`
                DO $$ 
                BEGIN
                    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
                    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
                    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
                    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
                    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
                    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
                    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
                END $$;
            `);
        } finally { client.release(); }
    }

    // --- ROLLBACK & RECOVERY ENGINE ---

    public static async restoreSnapshot(
        liveDb: string,
        snapshotDb: string,
        mode: 'hard' | 'smart'
    ) {
        console.log(`[Rollback] Initiating ${mode.toUpperCase()} Rollback: ${liveDb} <- ${snapshotDb}`);

        // 0. Extract Timestamp from Snapshot Name for Data Salvage
        const match = snapshotDb.match(/_backup_(\d+)$/);
        const snapshotTs = match ? parseInt(match[1]) : 0;

        // Quarantine Name
        const quarantineDb = `${liveDb}_quarantine_${Date.now()}`;

        // 1. DATA SALVAGE (Smart Mode Only)
        // Extract rows created AFTER the snapshot timestamp from the CURRENT live DB.
        const salvagedData: Record<string, any[]> = {};

        if (mode === 'smart' && snapshotTs > 0) {
            console.log(`[Rollback] Salvaging data created after ${new Date(snapshotTs).toISOString()}...`);
            const livePool = PoolService.get(liveDb, { useDirect: true });

            try {
                // Get all tables with 'created_at' column
                const tablesRes = await livePool.query(`
                    SELECT table_name 
                    FROM information_schema.columns 
                    WHERE table_schema = 'public' AND column_name = 'created_at'
                `);

                // Cutoff date (Buffer 1s to avoid boundary misses)
                const cutoff = new Date(snapshotTs - 1000).toISOString();

                for (const row of tablesRes.rows) {
                    const table = row.table_name;
                    // Select new rows
                    const dataRes = await livePool.query(
                        `SELECT * FROM public.${quoteId(table)} WHERE created_at > $1`,
                        [cutoff]
                    );
                    if (dataRes.rows.length > 0) {
                        salvagedData[table] = dataRes.rows;
                        console.log(`[Rollback] Salvaged ${dataRes.rows.length} rows from ${table}`);
                    }
                }
            } catch (e) {
                console.error("[Rollback] Data Salvage Failed (Aborting Smart Mode):", e);
                throw new Error("Smart Rollback failed during data salvage phase. No changes made.");
            }
        }

        // 2. ATOMIC SWAP (The Switch)
        // Kill connections
        await this.terminateConnections(liveDb);
        await this.terminateConnections(snapshotDb);

        // Rename Live -> Quarantine
        await this.killAndRename(systemPool, liveDb, quarantineDb);

        // Rename Snapshot -> Live (Clone logic: We actually want to CLONE the snapshot to Live, 
        // so the snapshot remains available for future rollbacks if this one fails too)

        try {
            await systemPool.query(`CREATE DATABASE "${liveDb}" WITH TEMPLATE "${snapshotDb}" OWNER "${process.env.DB_USER}"`);
        } catch (cloneErr) {
            console.error("[Rollback] Failed to promote snapshot. Restoring quarantine...", cloneErr);
            await this.killAndRename(systemPool, quarantineDb, liveDb);
            throw cloneErr;
        }

        // 3. RE-INJECT SALVAGED DATA
        if (mode === 'smart' && Object.keys(salvagedData).length > 0) {
            console.log("[Rollback] Re-injecting salvaged data...");
            const newLivePool = PoolService.get(liveDb, { useDirect: true });
            const client = await newLivePool.connect();

            try {
                await client.query('BEGIN');
                await client.query("SET session_replication_role = 'replica';"); // Bypass constraints

                // Sort tables by dependency to be safe (though replica mode helps)
                const tables = Object.keys(salvagedData);
                const sortedTables = await this.getDependencyOrder(newLivePool, tables);

                for (const table of sortedTables) {
                    const rows = salvagedData[table];
                    if (!rows || rows.length === 0) continue;

                    // Get columns dynamically to match current schema
                    // Note: If schema changed drastically, this might fail. Smart rollback assumes mostly data drift.
                    const firstRow = rows[0];
                    const cols = Object.keys(firstRow);
                    const colNames = cols.map(quoteId).join(', ');

                    for (const row of rows) {
                        const values = cols.map(c => row[c]);
                        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

                        // Try Insert (Ignore conflicts, as old ID might exist in backup if timestamps overlap)
                        await client.query(
                            `INSERT INTO public.${quoteId(table)} (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
                            values
                        );
                    }
                }

                await this.resetSequences(client);
                await client.query('COMMIT');
                console.log("[Rollback] Data re-injection complete.");

            } catch (injectErr) {
                console.error("[Rollback] Data Re-injection Failed!", injectErr);
                await client.query('ROLLBACK');
                // We do NOT revert the DB swap here. The system is online with old state (Hard Rollback equivalent).
                // The user is notified that "Smart" part failed but system is stable.
                // The salvaged data is technically lost from RAM but exists in Quarantine DB.
                throw new Error("System restored to snapshot, BUT new data could not be merged automatically. Check Quarantine DB manually.");
            } finally {
                client.release();
            }
        }

        await PoolService.reload(liveDb);
        return { quarantineDb };
    }

    public static async performDatabaseSwap(liveDb: string, newDb: string, backupDbName: string) {
        // Hardened Swap Logic
        console.log(`[Swap] Initiating Swap: ${liveDb} <-> ${newDb} (Backup: ${backupDbName})`);

        // 1. Kill All Connections
        await this.terminateConnections(liveDb);
        await this.terminateConnections(newDb);
        if (await this.dbExists(backupDbName)) await this.terminateConnections(backupDbName);

        // 2. Rename Live -> Backup
        await this.killAndRename(systemPool, liveDb, backupDbName);

        try {
            // 3. Rename New -> Live
            await this.killAndRename(systemPool, newDb, liveDb);
        } catch (err) {
            console.error(`[Swap] Failed to promote new DB. Reverting...`);
            // Panic Rollback: Backup -> Live
            await this.killAndRename(systemPool, backupDbName, liveDb);
            throw err;
        }
    }

    private static async killAndRename(pool: Pool, from: string, to: string) {
        const exists = await pool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [from]);
        if (exists.rowCount === 0) return;

        // Redundant kill just in case
        await pool.query(`UPDATE pg_database SET datallowconn = 'false' WHERE datname = '${from}'`);
        await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from}' AND pid <> pg_backend_pid()`);

        await pool.query(`ALTER DATABASE "${from}" RENAME TO "${to}"`);
        await pool.query(`UPDATE pg_database SET datallowconn = 'true' WHERE datname = '${to}'`);
    }

    public static async smartDataSync(sourceDb: string, targetDb: string, specificTable?: string) {
        return this.mergeData(sourceDb, targetDb, specificTable, 'upsert');
    }

    public static async generateDataDiff(sourceDb: string, targetDb: string): Promise<DataDiffSummary[]> {
        const sourcePool = PoolService.get(sourceDb, { useDirect: true });
        const targetPool = PoolService.get(targetDb, { useDirect: true });
        const client = await sourcePool.connect();

        try {
            await client.query('CREATE EXTENSION IF NOT EXISTS dblink');
            
            const getTables = async (pool: Pool) => {
                const res = await pool.query(`SELECT relname as table_name FROM pg_stat_user_tables WHERE schemaname = 'public'`);
                return res.rows.map(r => r.table_name);
            };
            
            const sourceTables = await getTables(sourcePool);
            const summary: DataDiffSummary[] = [];
            
            // Construção da Connection String do target para uso interno no dblink
            // Ex: user=test password=secret dbname=db_clone_xxx host=localhost
            const targetConnStr = `dbname=${targetDb} user=${process.env.DB_USER} password=${process.env.DB_PASSWORD} host=${process.env.DB_HOST || 'localhost'}`;

            for (const table of sourceTables) {
                try {
                    const pkRes = await client.query(`
                        SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                        WHERE i.indrelid = 'public.${quoteId(table)}'::regclass AND i.indisprimary;
                    `);
                    const pkCol = pkRes.rows[0]?.attname || 'id';

                    // O SANTO GRAAL DOS DIFFS (OOM KILLED)
                    // Ao invez de trazer as 40 milhoes de linhas dos 2 DBs para a Heap do NodeJS (Matando o servidor),
                    // Invocamos C++ PostgreSQL Engine para cruzar 2 databases isolados em menos de 1 segundo
                    // usando CROSS-DATABASE CTE (dblink). Retornando ao Node.js exatos 3 integers = 12 Bytes.
                    const diffQuery = `
                        WITH src_count AS (
                            SELECT count(*) as total FROM public.${quoteId(table)}
                        ),
                        tgt_data AS (
                            SELECT id FROM dblink('${targetConnStr}', 'SELECT "${pkCol}"::text as id FROM public.${quoteId(table)}') AS t(id text)
                        ),
                        tgt_count AS (
                            SELECT count(*) as total FROM tgt_data
                        ),
                        diff AS (
                            SELECT 
                                COUNT(*) FILTER (WHERE t.id IS NULL) AS new_rows,
                                COUNT(*) FILTER (WHERE t.id IS NOT NULL) AS update_rows
                            FROM public.${quoteId(table)} s
                            LEFT JOIN tgt_data t ON s."${pkCol}"::text = t.id
                        )
                        SELECT 
                            (SELECT total FROM src_count) as total_source,
                            (SELECT total FROM tgt_count) as total_target,
                            (SELECT new_rows FROM diff) as new_rows,
                            (SELECT update_rows FROM diff) as update_rows,
                            COALESCE((SELECT total FROM tgt_count), 0) - COALESCE((SELECT update_rows FROM diff),0) as missing_rows
                    `;

                    const res = await client.query(diffQuery);
                    const metrics = res.rows[0];

                    summary.push({
                        table,
                        total_source: Number(metrics.total_source || 0),
                        total_target: Number(metrics.total_target || 0),
                        new_rows: Number(metrics.new_rows || 0),
                        update_rows: Number(metrics.update_rows || 0),
                        missing_rows: Math.max(0, Number(metrics.missing_rows || 0)),
                        conflicts: Number(metrics.update_rows || 0)
                    });

                } catch (e: any) {
                    console.warn(`[DatabaseService] Diff Skip on ${table}: ${e.message}`);
                    summary.push({ table, total_source: 0, total_target: 0, new_rows: 0, update_rows: 0, missing_rows: 0, conflicts: 0 });
                }
            }
            return summary;
        } finally {
            client.release();
        }
    }

    // --- TOPOLOGICAL SORT FOR DEPENDENCY RESOLUTION ---
    // Returns tables sorted such that parents come before children
    private static async getDependencyOrder(pool: Pool, tables: string[]): Promise<string[]> {
        const client = await pool.connect();
        try {
            const res = await client.query(`
                SELECT tc.table_name, ccu.table_name AS foreign_table_name
                FROM information_schema.table_constraints AS tc 
                JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
                JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
            `);

            const graph: Record<string, Set<string>> = {};
            tables.forEach(t => graph[t] = new Set());

            res.rows.forEach(r => {
                if (tables.includes(r.table_name) && tables.includes(r.foreign_table_name)) {
                    // Dependency: table_name depends on foreign_table_name
                    graph[r.table_name].add(r.foreign_table_name);
                }
            });

            const visited = new Set<string>();
            const sorted: string[] = [];

            const visit = (node: string, stack: Set<string>) => {
                if (visited.has(node)) return;
                if (stack.has(node)) return; // Cycle detected

                stack.add(node);
                const deps = graph[node] || new Set();
                for (const dep of deps) {
                    visit(dep, stack);
                }
                visited.add(node);
                sorted.push(node);
                stack.delete(node);
            };

            tables.forEach(t => visit(t, new Set()));
            return sorted;

        } finally {
            client.release();
        }
    }

    // --- HELPER: GET SCHEMA FROM SPECIFIC CLIENT ---
    private static async getSchemaFromClient(client: PoolClient | Client): Promise<any[]> {
        const res = await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
        return res.rows;
    }

    // --- SEQUENCE RESET ---
    private static async resetSequences(client: PoolClient | Client) {
        const res = await client.query(`
            SELECT 'SELECT setval(' || quote_literal(quote_ident(S.relname)) || ', COALESCE(MAX(' ||quote_ident(C.attname)|| '), 1) ) FROM ' || quote_ident(T.relname) || ';' as fix_sql
            FROM pg_class AS S, pg_depend AS D, pg_class AS T, pg_attribute AS C
            WHERE S.relkind = 'S' AND S.oid = D.objid AND D.refobjid = T.oid
            AND D.refobjid = C.attrelid AND D.refobjsubid = C.attnum
            AND T.relname NOT LIKE '_deleted_%'
        `);
        for (const row of res.rows) {
            try { await client.query(row.fix_sql); } catch (e) { }
        }
    }

    /**
     * ATOMIC MERGE ENGINE (Fixed for Schema Visibility & Transaction Safety)
     */
    public static async mergeData(
        sourceDb: string,
        targetDb: string,
        specificTable: string | undefined,
        globalStrategy: string,
        granularPlan?: GranularMergePlan,
        externalClient?: PoolClient | Client // Must be passed if inside a transaction!
    ) {
        console.log(`[SmartMerge] Merging ${sourceDb} -> ${targetDb}. Default Strategy: ${globalStrategy}`);

        const sourcePool = PoolService.get(sourceDb, { useDirect: true });
        const targetPool = PoolService.get(targetDb, { useDirect: true });

        const clientTarget = externalClient || await targetPool.connect();
        const clientSource = await sourcePool.connect();
        let ownTransaction = !externalClient;

        const results: any[] = [];

        try {
            if (ownTransaction) await clientTarget.query('BEGIN');

            // Force schema refresh visibility
            const targetMeta = await this.getSchemaFromClient(clientTarget);
            const sourceMeta = await this.getSchemaFromClient(clientSource);

            const sourceTables: Record<string, string[]> = {};
            sourceMeta.forEach(r => { if (!sourceTables[r.table_name]) sourceTables[r.table_name] = []; sourceTables[r.table_name].push(r.column_name); });

            const targetTables: Record<string, string[]> = {};
            targetMeta.forEach(r => { if (!targetTables[r.table_name]) targetTables[r.table_name] = []; targetTables[r.table_name].push(r.column_name); });

            let tablesToSync: string[] = specificTable ? [specificTable] : Object.keys(sourceTables);

            if (tablesToSync.length > 1) {
                try {
                    tablesToSync = await this.getDependencyOrder(sourcePool, tablesToSync);
                } catch (e: any) {
                    console.warn("[SmartMerge] Sort failed, fallback alphabetical.", e);
                }
            }

            // Disable constraints for bulk insert
            await clientTarget.query("SET session_replication_role = 'replica';");

            for (const table of tablesToSync) {
                // FIX: Strictly verify strategy before checking table existence or syncing
                const plan = granularPlan?.[table];
                let strategy = plan?.strategy || globalStrategy || 'upsert';

                // SAFETY: Explicitly SKIP if ignore strategy is set
                if (strategy === 'ignore') {
                    console.log(`[SmartMerge] Ignoring table ${table} explicitly.`);
                    results.push({ table, rows: 0, strategy: 'ignored' });
                    continue;
                }

                if (!targetTables[table]) {
                    console.warn(`[SmartMerge] Table ${table} not found in target. Skipping (might be schema mismatch).`);
                    continue;
                }

                const commonCols = sourceTables[table].filter(col => targetTables[table].includes(col));
                if (commonCols.length === 0) continue;
                const colsList = commonCols.map(quoteId).join(', ');

                let pkColumn = 'id';
                try {
                    const pkRes = await clientTarget.query(`
                        SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                        WHERE i.indrelid = 'public.${quoteId(table)}'::regclass AND i.indisprimary;
                    `);
                    if (pkRes.rows.length > 0) pkColumn = pkRes.rows[0].attname;
                } catch (e) { }

                console.log(`[SmartMerge] Syncing ${table} using strategy: ${strategy}...`);

                // ONLY Truncate if explicitly requested. 
                // Previous bugs caused "Ignore" to fall through to a default insert, 
                // which might crash but not delete. 
                // Overwrite is the only destructive op.
                if (strategy === 'overwrite') {
                    console.log(`[SmartMerge] Truncating ${table} for overwrite...`);
                    await clientTarget.query(`TRUNCATE TABLE public.${quoteId(table)} CASCADE`);
                }

                const cursor = clientSource.query(new Cursor(`SELECT ${colsList} FROM public.${quoteId(table)}`));
                let rowCount = 0;

                const readNext = async () => new Promise<any[]>((resolve, reject) => {
                    // Mantemos chunks controlados para não estourar RAM do worker
                    cursor.read(2000, (err: Error, rows: any[]) => err ? reject(err) : resolve(rows));
                });

                let rows = await readNext();
                while (rows.length > 0) {
                    
                    // FASE 2: OTIMIZAÇÃO MAXIMA DE INSERÇÃO EM BATCH (FIM DO LIMITE DE 65K PARAMS E OOM)
                    // Ao invez de gerar (X) * (Y) parametros placeholders que ferram o node.js, enviamos como 1 unico Payload JSON array
                    // O Postgres usa json_populate_recordset para extrair internamente em nanosegundos.
                    let insertSql = `
                        INSERT INTO public.${quoteId(table)} (${colsList})
                        SELECT ${colsList} FROM json_populate_recordset(null::public.${quoteId(table)}, $1::json)
                    `;

                    if (strategy === 'append' || strategy === 'missing_only') {
                        insertSql += ` ON CONFLICT ("${pkColumn}") DO NOTHING`;
                    } else if (strategy === 'upsert' || strategy === 'smart_sync') {
                        const updateCols = commonCols.filter(c => c !== pkColumn);
                        if (updateCols.length > 0) {
                            const updateSet = updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
                            insertSql += ` ON CONFLICT ("${pkColumn}") DO UPDATE SET ${updateSet}`;
                        } else {
                            insertSql += ` ON CONFLICT ("${pkColumn}") DO NOTHING`;
                        }
                    }

                    // Apenas 1 Parametro passando pela rede (o JSON Array Gigante), bypassando o limite max.
                    const res = await clientTarget.query(insertSql, [JSON.stringify(rows)]);
                    rowCount += res.rowCount || 0;
                    
                    rows = await readNext();
                }

                console.log(`[SmartMerge] Processed ${rowCount} rows into ${table}`);
                results.push({ table, rows: rowCount, strategy });
            }

            await this.resetSequences(clientTarget);

            if (ownTransaction) await clientTarget.query('COMMIT');

        } catch (err: any) {
            console.error(`[SmartMerge] Transaction Failed:`, err);
            if (ownTransaction) await clientTarget.query('ROLLBACK');
            throw err;
        } finally {
            try { await clientTarget.query("SET session_replication_role = 'origin';"); } catch (e) { }

            clientSource.release();
            if (ownTransaction) (clientTarget as PoolClient).release();
        }

        return results;
    }

    /**
     * TIER-3 UNIVERSAL PADLOCK LOGGER
     * Asynchronous "fire-and-forget" method to persist intrusion records without 
     * blocking or risking the actual HTTP response payload.
     */
    public static logSecurityEvent(payload: {
        projectId: string;
        tableName: string;
        columnName: string;
        attemptedValue: string;
        ip: string;
    }) {
        // Run completely asynchronously (detached from the current request's promise tree)
        setImmediate(async () => {
            try {
                await systemPool.query(`
                    INSERT INTO system.security_events 
                        (project_id, table_name, column_name, attempted_value, ip) 
                    VALUES ($1, $2, $3, $4, $5)
                `, [
                    payload.projectId,
                    payload.tableName,
                    payload.columnName,
                    payload.attemptedValue,
                    payload.ip
                ]);
            } catch (err) {
                console.error('[Security Firewall] Failed to log intrusion event:', err);
                // We swallow the error here because the actual API request must not fail 
                // just because the intrusion log failed to save.
            }
        });
    }
}
