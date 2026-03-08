
-- ============================================================
-- Migration 029: Extension Registry
-- ============================================================
-- Tracks Phantom-injected extensions and per-project installations.
-- Used by ExtensionService to manage the extension lifecycle.
-- ============================================================

-- Registry of extensions injected via Phantom Injection (Docker image extraction)
-- One entry per extension, shared across all projects (since the .so files are shared)
CREATE TABLE IF NOT EXISTS system.extension_registry (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    extension_name TEXT NOT NULL,
    source_image TEXT,
    injected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'injected',
    file_size_bytes BIGINT DEFAULT 0,
    UNIQUE(extension_name)
);

-- Per-project extension installation tracking
-- Allows us to know which extensions are active in which project
CREATE TABLE IF NOT EXISTS system.project_extensions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_slug TEXT NOT NULL,
    extension_name TEXT NOT NULL,
    installed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    installed_version TEXT,
    UNIQUE(project_slug, extension_name)
);

-- Index for fast lookups by project
CREATE INDEX IF NOT EXISTS idx_project_extensions_slug
    ON system.project_extensions(project_slug);

-- Index for fast lookups by extension
CREATE INDEX IF NOT EXISTS idx_extension_registry_name
    ON system.extension_registry(extension_name);
