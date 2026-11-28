ALTER TABLE fleet_pin_owner ADD COLUMN pin_change_id TEXT;
ALTER TABLE fleet_sync_credentials ADD COLUMN approved_at INTEGER;
ALTER TABLE fleet_sync_credentials ADD COLUMN replaces_id TEXT;
