-- Adds updated_at column and trigger for Webhook integrity.
-- Phase: Infrastructure Sync

-- 1. Add updated_at column to system.webhooks
ALTER TABLE system.webhooks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- 2. Apply trigger to system.webhooks (Function system.update_updated_at_column should already exist from migration 031)
DROP TRIGGER IF EXISTS trg_webhooks_updated_at ON system.webhooks;
CREATE TRIGGER trg_webhooks_updated_at
    BEFORE UPDATE ON system.webhooks
    FOR EACH ROW
    EXECUTE FUNCTION system.update_updated_at_column();
