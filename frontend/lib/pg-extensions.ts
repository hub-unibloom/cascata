
export interface ExtensionMeta {
    name: string;
    category: 'AI' | 'Admin' | 'Audit' | 'Crypto' | 'DataType' | 'Geo' | 'Index' | 'Lang' | 'Net' | 'Search' | 'Time' | 'Util';
    description: string;
    featured?: boolean;
}

export const EXTENSIONS_CATALOG: ExtensionMeta[] = [
    // --- AI & VECTOR ---
    { name: 'vector', category: 'AI', description: 'Store and query vector embeddings. Essential for AI/RAG applications.', featured: true },
    
    // --- GEO ---
    { name: 'postgis', category: 'Geo', description: 'Spatial and geographic objects for PostgreSQL.', featured: true },
    { name: 'postgis_tiger_geocoder', category: 'Geo', description: 'Tiger Geocoder for PostGIS.' },
    { name: 'postgis_topology', category: 'Geo', description: 'Topology spatial types and functions.' },
    { name: 'address_standardizer', category: 'Geo', description: 'Parse addresses into elements. Useful for geocoding normalization.' },
    { name: 'address_standardizer_data_us', category: 'Geo', description: 'US dataset for address standardizer.' },
    { name: 'earthdistance', category: 'Geo', description: 'Calculate great circle distances on the surface of the Earth.' },
    { name: 'pgrouting', category: 'Geo', description: 'Geospatial routing functionality.' },

    // --- CRYPTO & SECURITY ---
    { name: 'pgcrypto', category: 'Crypto', description: 'Cryptographic functions (hashing, encryption, UUID generation).', featured: true },
    { name: 'pgsodium', category: 'Crypto', description: 'Modern cryptography using libsodium (encryption, signatures, hashing).' },
    { name: 'pgjwt', category: 'Crypto', description: 'JSON Web Token API for PostgreSQL.' },
    { name: 'anon', category: 'Crypto', description: 'Data anonymization tools.' },

    // --- SEARCH & TEXT ---
    { name: 'pg_trgm', category: 'Search', description: 'Text similarity measurement and index searching based on trigrams.', featured: true },
    { name: 'fuzzystrmatch', category: 'Search', description: 'Determine similarities and distances between strings (Levenshtein, Soundex).' },
    { name: 'unaccent', category: 'Search', description: 'Text search dictionary that removes accents.' },
    { name: 'dict_int', category: 'Search', description: 'Text search dictionary template for integers.' },
    { name: 'dict_xsyn', category: 'Search', description: 'Text search dictionary template for extended synonym processing.' },
    { name: 'btree_gin', category: 'Index', description: 'Support for indexing common data types in GIN.' },
    { name: 'btree_gist', category: 'Index', description: 'Support for indexing common data types in GiST.' },
    { name: 'rum', category: 'Index', description: 'RUM index method (faster full text search).' },
    { name: 'pgroonga', category: 'Search', description: 'Fast full text search for all languages based on Groonga.' },

    // --- DATA TYPES ---
    { name: 'uuid-ossp', category: 'DataType', description: 'Functions to generate universally unique identifiers (UUIDs).', featured: true },
    { name: 'hstore', category: 'DataType', description: 'Data type for storing sets of (key, value) pairs.' },
    { name: 'citext', category: 'DataType', description: 'Case-insensitive character string type.' },
    { name: 'ltree', category: 'DataType', description: 'Hierarchical tree-like data structure.' },
    { name: 'isn', category: 'DataType', description: 'Data types for international product numbering standards (ISBN, EAN, UPC).' },
    { name: 'cube', category: 'DataType', description: 'Data type for multidimensional cubes.' },
    { name: 'seg', category: 'DataType', description: 'Data type for line segments or floating point intervals.' },
    { name: 'intarray', category: 'DataType', description: 'Functions, operators, and indexes for 1-D arrays of integers.' },

    // --- UTILITY & ADMIN ---
    { name: 'pg_cron', category: 'Util', description: 'Job scheduler for PostgreSQL (run SQL on a schedule).', featured: true },
    { name: 'pg_net', category: 'Net', description: 'Async HTTP client (GET, POST) directly from SQL.' },
    { name: 'http', category: 'Net', description: 'HTTP client for PostgreSQL, allows retrieving web pages.' },
    { name: 'pg_stat_statements', category: 'Audit', description: 'Track execution statistics of all SQL statements executed.' },
    { name: 'pgaudit', category: 'Audit', description: 'Provide auditing functionality.' },
    { name: 'pg_graphql', category: 'Util', description: 'GraphQL support for PostgreSQL.' },
    { name: 'pg_jsonschema', category: 'Util', description: 'JSON Schema validation for JSONB columns.' },
    { name: 'pg_hashids', category: 'Util', description: 'Short unique IDs from integers (like YouTube IDs).' },
    { name: 'timescaledb', category: 'Time', description: 'Scalable inserts and complex queries for time-series data.' },
    { name: 'postgres_fdw', category: 'Admin', description: 'Foreign-data wrapper for remote PostgreSQL servers.' },
    { name: 'dblink', category: 'Admin', description: 'Connect to other PostgreSQL databases from within a database.' },
    { name: 'amcheck', category: 'Admin', description: 'Functions for verifying relation integrity.' },
    { name: 'pageinspect', category: 'Admin', description: 'Inspect the contents of database pages at a low level.' },
    { name: 'pg_buffercache', category: 'Admin', description: 'Examine the shared buffer cache.' },
    { name: 'pg_freespacemap', category: 'Admin', description: 'Examine the free space map (FSM).' },
    { name: 'pg_visibility', category: 'Admin', description: 'Examine the visibility map (VM) and page-level visibility information.' },
    { name: 'pg_walinspect', category: 'Admin', description: 'Inspect the contents of Write-Ahead Log.' },
    { name: 'pg_repack', category: 'Admin', description: 'Reorganize tables in PostgreSQL databases with minimal locks.' },
    { name: 'moddatetime', category: 'Util', description: 'Functions for tracking last modification time.' },
    { name: 'autoinc', category: 'Util', description: 'Functions for autoincrementing fields.' },
    { name: 'insert_username', category: 'Util', description: 'Functions for tracking who changed a table.' },
    
    // --- LANGUAGES ---
    { name: 'plpgsql', category: 'Lang', description: 'PL/pgSQL procedural language.' },
    { name: 'plv8', category: 'Lang', description: 'PL/JavaScript (v8) trusted procedural language.' },
    { name: 'pljava', category: 'Lang', description: 'PL/Java procedural language.' },
    { name: 'plpython3u', category: 'Lang', description: 'PL/Python procedural language.' }
];

export const getExtensionMeta = (name: string): ExtensionMeta => {
    const found = EXTENSIONS_CATALOG.find(e => e.name === name);
    return found || { 
        name, 
        category: 'Util', 
        description: 'No description available for this extension.' 
    };
};
