
// ============================================================
// PostgreSQL Extension Catalog — Realistic Enterprise Grade
// ============================================================
// Only extensions that ACTUALLY WORK on postgres:18-alpine are listed.
// Fictitious extensions (plv8, pljava, pgsodium, pgjwt, pg_net,
// pg_graphql, pg_jsonschema, rum, pgroonga, anon, pg_hashids)
// have been removed — they never worked on this image.
//
// Each extension has metadata about its source (native/phantom),
// tier (0-3), and estimated install size.
// ============================================================

export type ExtensionOrigin = 'native' | 'preloaded' | 'phantom';
export type ExtensionStatus = 'available' | 'injecting' | 'ready' | 'installed' | 'error';

export interface ExtensionMeta {
    name: string;
    category: 'AI' | 'Admin' | 'Audit' | 'Crypto' | 'DataType' | 'Geo' | 'Index' | 'Lang' | 'Search' | 'Time' | 'Util';
    description: string;
    featured?: boolean;
    origin: ExtensionOrigin;   // native=Alpine builtin, preloaded=Dockerfile, phantom=Docker image
    tier: number;              // 0=base, 1=AI, 2=Geo, 3=Heavy
    sourceImage?: string;      // Docker image source (phantom only)
    estimateMB?: number;       // Install size in MB (phantom only)
}

export const EXTENSIONS_CATALOG: ExtensionMeta[] = [
    // ─── AI & VECTOR (Tier 1 — Phantom) ───────────────────────
    { name: 'vector', category: 'AI', description: 'Store and query vector embeddings. Essential for AI/RAG applications.', featured: true, origin: 'phantom', tier: 1, sourceImage: 'pgvector/pgvector:0.8.0-pg18', estimateMB: 5 },

    // ─── GEO (Tier 2 — Phantom) ───────────────────────────────
    { name: 'postgis', category: 'Geo', description: 'Spatial and geographic objects for PostgreSQL.', featured: true, origin: 'phantom', tier: 2, sourceImage: 'postgis/postgis:18-3.6-alpine', estimateMB: 80 },
    { name: 'postgis_tiger_geocoder', category: 'Geo', description: 'Tiger Geocoder for PostGIS.', origin: 'phantom', tier: 2, sourceImage: 'postgis/postgis:18-3.6-alpine', estimateMB: 0 },
    { name: 'postgis_topology', category: 'Geo', description: 'Topology spatial types and functions.', origin: 'phantom', tier: 2, sourceImage: 'postgis/postgis:18-3.6-alpine', estimateMB: 0 },
    { name: 'address_standardizer', category: 'Geo', description: 'Parse addresses into elements. Useful for geocoding normalization.', origin: 'phantom', tier: 2, sourceImage: 'postgis/postgis:18-3.6-alpine', estimateMB: 0 },
    { name: 'address_standardizer_data_us', category: 'Geo', description: 'US dataset for address standardizer.', origin: 'phantom', tier: 2, sourceImage: 'postgis/postgis:18-3.6-alpine', estimateMB: 0 },

    // ─── TIME SERIES (Tier 3 — Phantom) ───────────────────────
    { name: 'timescaledb', category: 'Time', description: 'Scalable inserts and complex queries for time-series data.', featured: true, origin: 'phantom', tier: 3, sourceImage: 'timescale/timescaledb-ha:pg18', estimateMB: 35 },

    // ─── GEO (Tier 0 — Native) ────────────────────────────────
    { name: 'earthdistance', category: 'Geo', description: 'Calculate great circle distances on the surface of the Earth.', origin: 'native', tier: 0 },

    // ─── CRYPTO & SECURITY (Tier 0 — Native) ──────────────────
    { name: 'pgcrypto', category: 'Crypto', description: 'Cryptographic functions (hashing, encryption, UUID generation).', featured: true, origin: 'native', tier: 0 },

    // ─── SEARCH & TEXT (Tier 0 — Native) ──────────────────────
    { name: 'pg_trgm', category: 'Search', description: 'Text similarity measurement and index searching based on trigrams.', featured: true, origin: 'native', tier: 0 },
    { name: 'fuzzystrmatch', category: 'Search', description: 'Determine similarities and distances between strings (Levenshtein, Soundex).', origin: 'native', tier: 0 },
    { name: 'unaccent', category: 'Search', description: 'Text search dictionary that removes accents.', origin: 'native', tier: 0 },
    { name: 'dict_int', category: 'Search', description: 'Text search dictionary template for integers.', origin: 'native', tier: 0 },
    { name: 'dict_xsyn', category: 'Search', description: 'Text search dictionary template for extended synonym processing.', origin: 'native', tier: 0 },

    // ─── INDEX (Tier 0 — Native) ──────────────────────────────
    { name: 'btree_gin', category: 'Index', description: 'Support for indexing common data types in GIN.', origin: 'native', tier: 0 },
    { name: 'btree_gist', category: 'Index', description: 'Support for indexing common data types in GiST.', origin: 'native', tier: 0 },

    // ─── DATA TYPES (Tier 0 — Native) ─────────────────────────
    { name: 'uuid-ossp', category: 'DataType', description: 'Functions to generate universally unique identifiers (UUIDs).', featured: true, origin: 'native', tier: 0 },
    { name: 'hstore', category: 'DataType', description: 'Data type for storing sets of (key, value) pairs.', origin: 'native', tier: 0 },
    { name: 'citext', category: 'DataType', description: 'Case-insensitive character string type.', origin: 'native', tier: 0 },
    { name: 'ltree', category: 'DataType', description: 'Hierarchical tree-like data structure.', origin: 'native', tier: 0 },
    { name: 'isn', category: 'DataType', description: 'Data types for international product numbering standards (ISBN, EAN, UPC).', origin: 'native', tier: 0 },
    { name: 'cube', category: 'DataType', description: 'Data type for multidimensional cubes.', origin: 'native', tier: 0 },
    { name: 'seg', category: 'DataType', description: 'Data type for line segments or floating point intervals.', origin: 'native', tier: 0 },
    { name: 'intarray', category: 'DataType', description: 'Functions, operators, and indexes for 1-D arrays of integers.', origin: 'native', tier: 0 },

    // ─── UTILITY & ADMIN (Tier 0/Preloaded) ──────────────────────
    // pg_cron: compilado no Dockerfile multi-stage contra PG18 + shared_preload_libraries.
    // pg_stat_statements: contrib nativo, ativado via shared_preload_libraries.
    { name: 'pg_cron', category: 'Util', description: 'Job scheduler for PostgreSQL (run SQL on a cron schedule).', featured: true, origin: 'preloaded', tier: 0 },
    { name: 'pg_stat_statements', category: 'Audit', description: 'Track execution statistics of all SQL statements executed.', origin: 'native', tier: 0 },
    { name: 'pgaudit', category: 'Audit', description: 'Provide auditing functionality.', origin: 'native', tier: 0 },
    { name: 'postgres_fdw', category: 'Admin', description: 'Foreign-data wrapper for remote PostgreSQL servers.', origin: 'native', tier: 0 },
    { name: 'dblink', category: 'Admin', description: 'Connect to other PostgreSQL databases from within a database.', origin: 'native', tier: 0 },
    { name: 'amcheck', category: 'Admin', description: 'Functions for verifying relation integrity.', origin: 'native', tier: 0 },
    { name: 'pageinspect', category: 'Admin', description: 'Inspect the contents of database pages at a low level.', origin: 'native', tier: 0 },
    { name: 'pg_buffercache', category: 'Admin', description: 'Examine the shared buffer cache.', origin: 'native', tier: 0 },
    { name: 'pg_freespacemap', category: 'Admin', description: 'Examine the free space map (FSM).', origin: 'native', tier: 0 },
    { name: 'pg_visibility', category: 'Admin', description: 'Examine the visibility map (VM) and page-level visibility information.', origin: 'native', tier: 0 },
    { name: 'pg_walinspect', category: 'Admin', description: 'Inspect the contents of Write-Ahead Log.', origin: 'native', tier: 0 },
    { name: 'moddatetime', category: 'Util', description: 'Functions for tracking last modification time.', origin: 'native', tier: 0 },
    { name: 'autoinc', category: 'Util', description: 'Functions for autoincrementing fields.', origin: 'native', tier: 0 },
    { name: 'insert_username', category: 'Util', description: 'Functions for tracking who changed a table.', origin: 'native', tier: 0 },

    // ─── LANGUAGES (Tier 0 — Native) ──────────────────────────
    { name: 'plpgsql', category: 'Lang', description: 'PL/pgSQL procedural language.', origin: 'native', tier: 0 },
    { name: 'plpython3u', category: 'Lang', description: 'PL/Python procedural language.', origin: 'native', tier: 0 },
];

export const getExtensionMeta = (name: string): ExtensionMeta => {
    const found = EXTENSIONS_CATALOG.find(e => e.name === name);
    return found || {
        name,
        category: 'Util',
        description: 'No description available for this extension.',
        origin: 'native' as ExtensionOrigin,
        tier: 0
    };
};

// Tier labels for UI display
export const TIER_LABELS: Record<number, { label: string; color: string; description: string }> = {
    0: { label: 'Base', color: '#10b981', description: 'Included in base image' },
    1: { label: 'AI', color: '#8b5cf6', description: 'AI & Vector capabilities' },
    2: { label: 'Geo', color: '#3b82f6', description: 'Geospatial capabilities' },
    3: { label: 'Heavy', color: '#f59e0b', description: 'Resource-intensive extensions' }
};

// Origin labels for UI display
export const ORIGIN_LABELS: Record<ExtensionOrigin, { label: string; icon: string }> = {
    native: { label: 'Native', icon: '✓' },
    preloaded: { label: 'Pre-loaded', icon: '⚡' },
    phantom: { label: 'Phantom Inject', icon: '🚀' }
};
