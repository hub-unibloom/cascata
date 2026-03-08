-- Adds updated_at column and trigger for Logic Engine integrity.
-- Phase: Infrastructure Sync

-- 1. Add updated_at column to system.assets
ALTER TABLE system.assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- 2. Create the update_updated_at_column function if it doesn't exist
CREATE OR REPLACE FUNCTION system.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 3. Apply trigger to system.assets
DROP TRIGGER IF EXISTS trg_assets_updated_at ON system.assets;
CREATE TRIGGER trg_assets_updated_at
    BEFORE UPDATE ON system.assets
    FOR EACH ROW
    EXECUTE FUNCTION system.update_updated_at_column();
