
import { Pool } from 'pg';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { systemPool } from '../src/config/main.js';

const execAsync = promisify(exec);

// ============================================================
// PostgreSQL Extension Source Registry
// ============================================================
// Maps extension names to their Docker image source.
// Only extensions that need Phantom Injection (not native to Alpine)
// are listed here. Native extensions work out-of-the-box.
// ============================================================

interface PhantomSource {
    image: string;           // Docker image to extract from
    provides: string[];      // List of extensions provided by this image
    estimateMB: number;      // Estimated size impact in MB
    description: string;     // Human-readable description
}

// Each image can provide multiple extensions
const PHANTOM_SOURCES: PhantomSource[] = [
    {
        image: 'pgvector/pgvector:0.8.0-pg18',
        provides: ['vector'],
        estimateMB: 5,
        description: 'pgvector — AI/RAG vector embeddings'
    },
    {
        image: 'postgis/postgis:18-3.6-alpine',
        provides: ['postgis', 'postgis_tiger_geocoder', 'postgis_topology', 'address_standardizer', 'address_standardizer_data_us'],
        estimateMB: 80,
        description: 'PostGIS — Geospatial functions'
    },
    {
        image: 'timescale/timescaledb-ha:pg18',
        provides: ['timescaledb'],
        estimateMB: 35,
        description: 'TimescaleDB — Time-series data'
    }
];

// Extensions that are native to postgres:18-alpine (always available)
const NATIVE_EXTENSIONS = new Set([
    'plpgsql', 'pgcrypto', 'uuid-ossp', 'pg_trgm', 'citext', 'hstore',
    'ltree', 'btree_gin', 'btree_gist', 'fuzzystrmatch', 'unaccent',
    'intarray', 'earthdistance', 'cube', 'seg', 'isn', 'dict_int',
    'dict_xsyn', 'postgres_fdw', 'dblink',
    'amcheck', 'pageinspect', 'pg_buffercache', 'pg_freespacemap',
    'pg_visibility', 'pg_walinspect', 'moddatetime', 'autoinc',
    'insert_username', 'pgaudit', 'plpython3u'
]);

// Extensions compiled/installed in the Dockerfile (Tier 0).
// pg_cron: compilado do source no Dockerfile multi-stage (PG18 compatível).
// pg_stat_statements: contrib nativo, ativado via shared_preload_libraries.
const PRELOADED_EXTENSIONS = new Set([
    'pg_cron',
    'pg_stat_statements'
]);

// Build a reverse lookup: extension name -> phantom source
const PHANTOM_LOOKUP = new Map<string, PhantomSource>();
for (const source of PHANTOM_SOURCES) {
    for (const ext of source.provides) {
        PHANTOM_LOOKUP.set(ext, source);
    }
}

// Volume paths (inside the backend container, mounted read-only for verification)
const EXTENSIONS_VOLUME = '/cascata_extensions';
const EXT_LIB_PATH = path.join(EXTENSIONS_VOLUME, 'lib');
const EXT_SHARE_PATH = path.join(EXTENSIONS_VOLUME, 'share');

// Docker volume name (must match docker-compose.yml)
const VOLUME_NAME = 'cascata_extension_payloads';

// ============================================================
// Extension Status Types
// ============================================================

export type ExtensionOrigin = 'native' | 'preloaded' | 'phantom';
export type ExtensionStatus = 'available' | 'injecting' | 'ready' | 'installed' | 'error';

export interface EnrichedExtension {
    name: string;
    category: string;
    description: string;
    featured: boolean;
    origin: ExtensionOrigin;
    status: ExtensionStatus;
    installed_version: string | null;
    default_version: string | null;
    source_image: string | null;
    estimate_mb: number;
    tier: number; // 0=native/preloaded, 1=phantom-light, 2=phantom-geo, 3=phantom-heavy
}

// ============================================================
// ExtensionService — Core Phantom Injection Logic
// ============================================================

export class ExtensionService {

    // In-memory injection status tracking (per-extension)
    private static injectionStatus = new Map<string, { status: ExtensionStatus; message: string; startedAt: number }>();

    /**
     * Get enriched catalog: merges static metadata, pg_available_extensions,
     * and phantom injection status into a single unified list.
     */
    static async listAvailableEnriched(projectPool: Pool): Promise<EnrichedExtension[]> {
        // 1. Query what PostgreSQL actually has available
        const pgResult = await projectPool.query(`
            SELECT name, default_version, installed_version, comment 
            FROM pg_available_extensions 
            ORDER BY name ASC
        `);

        const pgMap = new Map<string, { default_version: string; installed_version: string | null; comment: string }>();
        for (const row of pgResult.rows) {
            pgMap.set(row.name, {
                default_version: row.default_version,
                installed_version: row.installed_version,
                comment: row.comment
            });
        }

        // 2. Query injection registry from system database
        let injectedMap = new Map<string, { source_image: string; status: string }>();
        try {
            const regResult = await systemPool.query(
                `SELECT extension_name, source_image, status FROM system.extension_registry`
            );
            for (const row of regResult.rows) {
                injectedMap.set(row.extension_name, {
                    source_image: row.source_image,
                    status: row.status
                });
            }
        } catch {
            // Table may not exist yet (migration not run)
        }

        // 3. Build enriched catalog from our known extensions
        const enriched: EnrichedExtension[] = [];
        const processedNames = new Set<string>();

        // Process all known extensions (native + phantom)
        const allKnown = new Set([
            ...NATIVE_EXTENSIONS,
            ...PRELOADED_EXTENSIONS,
            ...PHANTOM_LOOKUP.keys()
        ]);

        for (const name of allKnown) {
            processedNames.add(name);
            const pgInfo = pgMap.get(name);
            const injectedInfo = injectedMap.get(name);
            const phantomSource = PHANTOM_LOOKUP.get(name);

            let origin: ExtensionOrigin = 'native';
            let tier = 0;
            let sourceImage: string | null = null;
            let estimateMB = 0;

            if (PRELOADED_EXTENSIONS.has(name)) {
                origin = 'preloaded';
                tier = 0;
            } else if (phantomSource) {
                origin = 'phantom';
                sourceImage = phantomSource.image;
                estimateMB = phantomSource.estimateMB;

                // Determine tier based on source
                if (phantomSource.provides.includes('vector')) tier = 1;
                else if (phantomSource.provides.includes('postgis')) tier = 2;
                else tier = 3;
            }

            // Determine effective status
            let status: ExtensionStatus = 'available';
            if (pgInfo?.installed_version) {
                status = 'installed';
            } else if (pgInfo) {
                status = 'ready'; // Available in pg_available_extensions but not installed
            } else if (injectedInfo?.status === 'injected') {
                status = 'ready'; // Files injected but extension not yet in pg_available_extensions
            } else if (this.injectionStatus.has(name)) {
                status = this.injectionStatus.get(name)!.status;
            }

            enriched.push({
                name,
                category: this.getCategoryForExtension(name),
                description: pgInfo?.comment || this.getDescriptionForExtension(name),
                featured: this.isFeatured(name),
                origin,
                status,
                installed_version: pgInfo?.installed_version || null,
                default_version: pgInfo?.default_version || null,
                source_image: sourceImage,
                estimate_mb: estimateMB,
                tier
            });
        }

        // Also include any extensions from pg_available_extensions that we didn't know about
        // (system extensions that Alpine ships but we didn't list)

        // ENTERPRISE FIX: Filter out extensions that Alpine ships metadata for (.control)
        // but physically omits the underlying OS runtime (python, perl, tcl, pgaudit, etc) 
        // to maintain zero-bloat docker images.
        const brokenAlpineNatives = /^(plperl|plperlu|bool_plperl|bool_plperlu|hstore_plperl|hstore_plperlu|jsonb_plperlu|plpython3. |plpython3u|hstore_plpython3u|jsonb_plpython3u|ltree_plpython3u|pltcl|pltclu|pgaudit)$/i;

        for (const [name, info] of pgMap) {
            if (!processedNames.has(name) && !brokenAlpineNatives.test(name)) {
                enriched.push({
                    name,
                    category: 'Util',
                    description: info.comment || 'System extension',
                    featured: false,
                    origin: 'native',
                    status: info.installed_version ? 'installed' : 'ready',
                    installed_version: info.installed_version,
                    default_version: info.default_version,
                    source_image: null,
                    estimate_mb: 0,
                    tier: 0
                });
            }
        }

        // Sort: installed first, then featured, then by tier, then alphabetical
        enriched.sort((a, b) => {
            if (a.status === 'installed' && b.status !== 'installed') return -1;
            if (a.status !== 'installed' && b.status === 'installed') return 1;
            if (a.featured && !b.featured) return -1;
            if (!a.featured && b.featured) return 1;
            if (a.tier !== b.tier) return a.tier - b.tier;
            return a.name.localeCompare(b.name);
        });

        return enriched;
    }

    /**
     * Install an extension. For phantom extensions, this triggers Docker
     * image extraction first. For native extensions, goes straight to CREATE EXTENSION.
     */
    static async installExtension(
        projectPool: Pool,
        projectSlug: string,
        extensionName: string,
        targetSchema: string = 'extensions'
    ): Promise<{ success: boolean; message: string; requiresPhantom: boolean }> {
        // Validate extension name (security)
        if (!/^[a-zA-Z0-9_-]+$/.test(extensionName)) {
            throw new Error('Invalid extension name: only alphanumeric, underscore and hyphen allowed.');
        }

        // Check if it's a phantom extension that needs injection
        const phantomSource = PHANTOM_LOOKUP.get(extensionName);

        if (phantomSource) {
            // Check if already injected
            const isReady = await this.isExtensionReady(projectPool, extensionName);

            if (!isReady) {
                // Trigger Phantom Injection
                await this.phantomInject(phantomSource, extensionName);
            }
        }

        // Now create the extension in the project's schema
        try {
            if (extensionName === 'pg_cron') {
                // ENTERPRISE FIX: pg_cron runs strictly on the database defined in postgresql.conf 
                // (`cron.database_name`) which is cascata_system. We install it cleanly on the systemPool.
                // The Action Dispatcher handles cross-tenant automation virtually.
                await systemPool.query(
                    `CREATE EXTENSION IF NOT EXISTS "pg_cron" SCHEMA public CASCADE`
                );
            } else {
                const safeSchema = targetSchema === 'public' ? 'public' : `"${targetSchema}"`;

                // Create the isolated schema if it doesn't exist
                if (targetSchema !== 'public') {
                    await projectPool.query(`CREATE SCHEMA IF NOT EXISTS ${safeSchema};`);
                }

                // RACE CONDITION FIX: Set search_path at SESSION level before CREATE EXTENSION.
                // ALTER DATABASE SET search_path only affects NEW connections.
                // Pool connections keep the old search_path, so dependent extensions
                // (e.g. postgis_tiger_geocoder needing PostGIS's "geometry" type)
                // can't find types from the extensions schema without this.
                if (targetSchema !== 'public') {
                    await projectPool.query(
                        `SET search_path TO "$user", public, ${safeSchema}`
                    );
                }

                // Use safe quoting — extension names are validated above
                await projectPool.query(
                    `CREATE EXTENSION IF NOT EXISTS "${extensionName}" SCHEMA ${safeSchema} CASCADE`
                );

                // Supabase-style: Add schema to search path so types (like geometry) are globally accessible
                if (targetSchema !== 'public') {
                    await projectPool.query(`
                        DO $$
                        BEGIN
                            EXECUTE format('ALTER DATABASE %I SET search_path TO "$user", public, %I', current_database(), '${targetSchema}');
                        END
                        $$;
                    `);

                    // AUTO-GRANT: Ensure all Cascata roles can access extension objects
                    // This solves the "permission denied for schema extensions" problem
                    // that plagues even Supabase users
                    await projectPool.query(`
                        GRANT USAGE ON SCHEMA ${safeSchema} TO anon, authenticated, service_role, cascata_api_role;
                        GRANT SELECT ON ALL TABLES IN SCHEMA ${safeSchema} TO anon, authenticated, service_role, cascata_api_role;
                        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${safeSchema} TO anon, authenticated, service_role, cascata_api_role;
                        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${safeSchema} TO anon, authenticated, service_role, cascata_api_role;
                        ALTER DEFAULT PRIVILEGES IN SCHEMA ${safeSchema}
                            GRANT SELECT ON TABLES TO anon, authenticated, service_role, cascata_api_role;
                        ALTER DEFAULT PRIVILEGES IN SCHEMA ${safeSchema}
                            GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role, cascata_api_role;
                        ALTER DEFAULT PRIVILEGES IN SCHEMA ${safeSchema}
                            GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role, cascata_api_role;
                    `);
                }
            }

            // Record in project_extensions registry
            try {
                const versionResult = await projectPool.query(
                    `SELECT installed_version FROM pg_available_extensions WHERE name = $1`,
                    [extensionName]
                );
                const version = versionResult.rows[0]?.installed_version || null;

                await systemPool.query(
                    `INSERT INTO system.project_extensions (project_slug, extension_name, installed_version) 
                     VALUES ($1, $2, $3)
                     ON CONFLICT (project_slug, extension_name) DO UPDATE SET installed_version = $3, installed_at = NOW()`,
                    [projectSlug, extensionName, version]
                );
            } catch {
                // Registry table may not exist yet — non-fatal
            }

            // Clear injection status
            this.injectionStatus.delete(extensionName);

            return {
                success: true,
                message: `Extension "${extensionName}" installed successfully.`,
                requiresPhantom: !!phantomSource
            };
        } catch (err: any) {
            this.injectionStatus.set(extensionName, {
                status: 'error',
                message: err.message,
                startedAt: Date.now()
            });
            throw new Error(`Failed to create extension "${extensionName}": ${err.message}`);
        }
    }

    /**
     * Uninstall an extension from a project.
     */
    static async uninstallExtension(
        projectPool: Pool,
        projectSlug: string,
        extensionName: string,
        cascade: boolean = false
    ): Promise<{ success: boolean; message: string }> {
        if (!/^[a-zA-Z0-9_-]+$/.test(extensionName)) {
            throw new Error('Invalid extension name.');
        }

        // Protection: prevent dropping critical system extensions
        const PROTECTED = new Set(['plpgsql']);
        if (PROTECTED.has(extensionName)) {
            throw new Error(`Cannot drop protected system extension: ${extensionName}`);
        }

        const cascadeSql = cascade ? 'CASCADE' : '';

        if (extensionName === 'pg_cron') {
            await systemPool.query(`DROP EXTENSION IF EXISTS "pg_cron" ${cascadeSql}`);
        } else {
            await projectPool.query(
                `DROP EXTENSION IF EXISTS "${extensionName}" ${cascadeSql}`
            );
        }

        // Remove from project registry
        try {
            await systemPool.query(
                `DELETE FROM system.project_extensions WHERE project_slug = $1 AND extension_name = $2`,
                [projectSlug, extensionName]
            );
        } catch {
            // Non-fatal
        }

        return {
            success: true,
            message: `Extension "${extensionName}" removed.`
        };
    }

    /**
     * Check if an extension is ready to use (exists in pg_available_extensions).
     */
    static async isExtensionReady(pool: Pool, extensionName: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT 1 FROM pg_available_extensions WHERE name = $1`,
            [extensionName]
        );
        return result.rowCount! > 0;
    }

    /**
     * Get the current installation status for a specific extension.
     */
    static getInstallStatus(extensionName: string): { status: ExtensionStatus; message: string } {
        const info = this.injectionStatus.get(extensionName);
        if (!info) {
            return { status: 'available', message: 'No operation in progress.' };
        }
        return { status: info.status, message: info.message };
    }

    // ============================================================
    // Phantom Injection — Docker Image Extraction
    // ============================================================

    /**
     * Extract extension files from an official Docker image into
     * the shared extension_payloads volume. This is the core of
     * the True Phantom Injection architecture.
     *
     * How it works:
     * 1. docker run --rm creates a temporary container from the official image
     * 2. We copy the compiled .so files and .control/.sql files from the image
     * 3. Files land in /cascata_extensions (shared volume)
     * 4. The Phantom Linker (running inside the DB container) detects new files
     * 5. It creates symlinks in PostgreSQL's lib/share directories
     * 6. PostgreSQL can now load the extension on CREATE EXTENSION
     *
     * Zero downtime. Zero bloat for unused extensions.
     */
    private static async phantomInject(source: PhantomSource, requestedExtension: string): Promise<void> {
        console.log(`[ExtensionService] Phantom Injection starting for "${requestedExtension}" from ${source.image}`);

        this.injectionStatus.set(requestedExtension, {
            status: 'injecting',
            message: `Downloading ${source.image}...`,
            startedAt: Date.now()
        });

        try {
            // Check if image is already pulled (avoid re-downloading)
            let imagePulled = false;
            try {
                await execAsync(`docker image inspect ${source.image}`, { timeout: 10000 });
                imagePulled = true;
                console.log(`[ExtensionService] Image ${source.image} already cached locally.`);
            } catch {
                // Image not present, will need to pull
            }

            this.injectionStatus.set(requestedExtension, {
                status: 'injecting',
                message: imagePulled ? 'Extracting extension files...' : 'Pulling Docker image (first time only)...',
                startedAt: Date.now()
            });

            // ENTERPRISE FIX: Absolute deterministic volume mounting.
            // Eradicates reliance on grepping 'docker volume ls', Node stdout parsing,
            // or brittle Docker Compose prefix generation across diverse hosting platforms.
            // The volume is declared externally and statically in docker-compose.yml.
            const volumeName = 'cascata_extension_payloads';

            console.log(`[ExtensionService] Deterministic Volume Binding: ${volumeName}`);

            // The magic command: extract extension files from the official image
            // into our shared deterministic volume. The --rm flag ensures zero leftover containers.
            //
            // We copy from three locations inside the official image:
            // 1. /usr/local/lib/postgresql/ → .so files (compiled extensions)
            // 2. /usr/local/share/postgresql/extension/ → .control + .sql files
            // 3. /usr/lib/ → OS native libraries (libgeos, libproj, libpcre2) vital for extensions like PostGIS
            const extractCmd = [
                `docker run --rm`,
                `-v ${volumeName}:/cascata_extensions`,
                `--entrypoint sh`,
                source.image,
                `-c "`,
                `mkdir -p /cascata_extensions/lib /cascata_extensions/share /cascata_extensions/os_lib`,
                `&& cp -rn /usr/local/lib/postgresql/*.so /cascata_extensions/lib/ 2>/dev/null || true`,
                `&& cp -rn /usr/local/lib/postgresql/*.so.* /cascata_extensions/lib/ 2>/dev/null || true`,
                `&& cp -rn /usr/local/share/postgresql/extension/* /cascata_extensions/share/ 2>/dev/null || true`,
                `&& cp -n /usr/lib/*.so* /cascata_extensions/os_lib/ 2>/dev/null || true`,
                `&& echo PHANTOM_INJECT_OK`,
                `"`
            ].join(' ');

            console.log(`[ExtensionService] Executing: ${extractCmd.substring(0, 120)}...`);

            const { stdout, stderr } = await execAsync(extractCmd, {
                timeout: 300000 // 5 minute timeout (for initial image pull)
            });

            if (!stdout.includes('PHANTOM_INJECT_OK')) {
                throw new Error(`Extraction may have failed. stdout: ${stdout}, stderr: ${stderr}`);
            }

            console.log(`[ExtensionService] Phantom Injection complete for ${source.provides.join(', ')}`);

            // Record all provided extensions in the registry
            for (const ext of source.provides) {
                try {
                    await systemPool.query(
                        `INSERT INTO system.extension_registry (extension_name, source_image, status, file_size_bytes)
                         VALUES ($1, $2, 'injected', $3)
                         ON CONFLICT (extension_name) DO UPDATE SET status = 'injected', injected_at = NOW()`,
                        [ext, source.image, source.estimateMB * 1024 * 1024]
                    );
                } catch {
                    // Non-fatal — registry table may not exist
                }

                this.injectionStatus.set(ext, {
                    status: 'ready',
                    message: 'Extension files injected. Waiting for Phantom Linker...',
                    startedAt: Date.now()
                });
            }

            // Wait for the Phantom Linker to detect and symlink the files
            // The linker runs every 2-10 seconds depending on inotify/polling mode
            await this.waitForLinker(requestedExtension, 30000); // 30 second max wait

        } catch (err: any) {
            console.error(`[ExtensionService] Phantom Injection failed for "${requestedExtension}":`, err.message);

            for (const ext of source.provides) {
                this.injectionStatus.set(ext, {
                    status: 'error',
                    message: `Injection failed: ${err.message}`,
                    startedAt: Date.now()
                });
            }

            throw new Error(`Phantom Injection failed for "${requestedExtension}": ${err.message}`);
        }
    }

    /**
     * Wait for the Phantom Linker to pick up the injected files.
     * We do this by polling pg_available_extensions until the extension appears.
     */
    private static async waitForLinker(extensionName: string, timeoutMs: number): Promise<void> {
        const start = Date.now();
        const pollInterval = 2000; // 2 seconds

        console.log(`[ExtensionService] Waiting for Phantom Linker to detect "${extensionName}"...`);

        // Use systemPool to query pg_available_extensions (shared across all projects)
        while (Date.now() - start < timeoutMs) {
            try {
                const result = await systemPool.query(
                    `SELECT 1 FROM pg_available_extensions WHERE name = $1`,
                    [extensionName]
                );

                if (result.rowCount! > 0) {
                    console.log(`[ExtensionService] "${extensionName}" detected by PostgreSQL. Ready to use.`);
                    this.injectionStatus.set(extensionName, {
                        status: 'ready',
                        message: 'Extension ready to install.',
                        startedAt: Date.now()
                    });
                    return;
                }
            } catch {
                // Pool might be unavailable, keep trying
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // If we get here, the linker hasn't picked up the files yet
        // This is not necessarily an error — the extension might still work
        console.warn(`[ExtensionService] Timeout waiting for linker. Extension may still be available.`);
    }

    // ============================================================
    // Metadata Helpers (Static Extension Catalog)
    // ============================================================

    private static getCategoryForExtension(name: string): string {
        const categories: Record<string, string> = {
            'vector': 'AI',
            'postgis': 'Geo', 'postgis_tiger_geocoder': 'Geo',
            'postgis_topology': 'Geo', 'address_standardizer': 'Geo',
            'address_standardizer_data_us': 'Geo', 'earthdistance': 'Geo',
            'pgcrypto': 'Crypto',
            'pg_trgm': 'Search', 'fuzzystrmatch': 'Search',
            'unaccent': 'Search', 'dict_int': 'Search', 'dict_xsyn': 'Search',
            'btree_gin': 'Index', 'btree_gist': 'Index',
            'uuid-ossp': 'DataType', 'hstore': 'DataType', 'citext': 'DataType',
            'ltree': 'DataType', 'isn': 'DataType', 'cube': 'DataType',
            'seg': 'DataType', 'intarray': 'DataType',
            'pg_cron': 'Util', 'pg_stat_statements': 'Audit',
            'pgaudit': 'Audit', 'timescaledb': 'Time',
            'postgres_fdw': 'Admin', 'dblink': 'Admin',
            'amcheck': 'Admin', 'pageinspect': 'Admin',
            'pg_buffercache': 'Admin', 'pg_freespacemap': 'Admin',
            'pg_visibility': 'Admin', 'pg_walinspect': 'Admin',
            'moddatetime': 'Util', 'autoinc': 'Util',
            'insert_username': 'Util', 'plpgsql': 'Lang',
            'plpython3u': 'Lang'
        };
        return categories[name] || 'Util';
    }

    private static getDescriptionForExtension(name: string): string {
        const descriptions: Record<string, string> = {
            'vector': 'Store and query vector embeddings. Essential for AI/RAG applications.',
            'postgis': 'Spatial and geographic objects for PostgreSQL.',
            'postgis_tiger_geocoder': 'Tiger Geocoder for PostGIS.',
            'postgis_topology': 'Topology spatial types and functions.',
            'address_standardizer': 'Parse addresses into elements. Useful for geocoding normalization.',
            'address_standardizer_data_us': 'US dataset for address standardizer.',
            'earthdistance': 'Calculate great circle distances on the surface of the Earth.',
            'pgcrypto': 'Cryptographic functions (hashing, encryption, UUID generation).',
            'pg_trgm': 'Text similarity measurement and index searching based on trigrams.',
            'fuzzystrmatch': 'Determine similarities and distances between strings (Levenshtein, Soundex).',
            'unaccent': 'Text search dictionary that removes accents.',
            'dict_int': 'Text search dictionary template for integers.',
            'dict_xsyn': 'Text search dictionary template for extended synonym processing.',
            'btree_gin': 'Support for indexing common data types in GIN.',
            'btree_gist': 'Support for indexing common data types in GiST.',
            'uuid-ossp': 'Functions to generate universally unique identifiers (UUIDs).',
            'hstore': 'Data type for storing sets of (key, value) pairs.',
            'citext': 'Case-insensitive character string type.',
            'ltree': 'Hierarchical tree-like data structure.',
            'isn': 'Data types for international product numbering standards (ISBN, EAN, UPC).',
            'cube': 'Data type for multidimensional cubes.',
            'seg': 'Data type for line segments or floating point intervals.',
            'intarray': 'Functions, operators, and indexes for 1-D arrays of integers.',
            'pg_cron': 'Job scheduler for PostgreSQL (run SQL on a schedule).',
            'pg_stat_statements': 'Track execution statistics of all SQL statements executed.',
            'pgaudit': 'Provide auditing functionality.',
            'timescaledb': 'Scalable inserts and complex queries for time-series data.',
            'postgres_fdw': 'Foreign-data wrapper for remote PostgreSQL servers.',
            'dblink': 'Connect to other PostgreSQL databases from within a database.',
            'amcheck': 'Functions for verifying relation integrity.',
            'pageinspect': 'Inspect the contents of database pages at a low level.',
            'pg_buffercache': 'Examine the shared buffer cache.',
            'pg_freespacemap': 'Examine the free space map (FSM).',
            'pg_visibility': 'Examine the visibility map (VM) and page-level visibility information.',
            'pg_walinspect': 'Inspect the contents of Write-Ahead Log.',
            'moddatetime': 'Functions for tracking last modification time.',
            'autoinc': 'Functions for autoincrementing fields.',
            'insert_username': 'Functions for tracking who changed a table.',
            'plpgsql': 'PL/pgSQL procedural language.',
            'plpython3u': 'PL/Python procedural language.'
        };
        return descriptions[name] || 'PostgreSQL extension.';
    }

    private static isFeatured(name: string): boolean {
        const featured = new Set(['vector', 'postgis', 'pgcrypto', 'pg_trgm', 'uuid-ossp', 'pg_cron', 'timescaledb']);
        return featured.has(name);
    }
}
