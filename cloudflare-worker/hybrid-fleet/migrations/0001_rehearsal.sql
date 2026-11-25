CREATE TABLE fleet_rehearsal_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL UNIQUE
);
INSERT INTO fleet_rehearsal_state (id, epoch) VALUES (1, lower(hex(randomblob(16))));

CREATE TABLE fleet_sync_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  secret_sha256 TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('sync-read', 'sync-read-write')),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE fleet_records (
  kind TEXT NOT NULL CHECK (kind IN ('machine', 'service', 'mileage', 'invoice')),
  machine_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  data TEXT CHECK (data IS NULL OR json_valid(data)),
  CHECK ((deleted = 1) = (data IS NULL)),
  PRIMARY KEY (kind, machine_id, record_id)
);

CREATE TABLE fleet_mutations (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT UNIQUE NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  data TEXT,
  committed_at TEXT NOT NULL
);

-- The resulting row and its replay receipt become visible in one commit.
CREATE TRIGGER project_fleet_mutation AFTER INSERT ON fleet_mutations
BEGIN
  INSERT INTO fleet_records(kind, machine_id, record_id, service_id, revision, deleted, data)
    VALUES(NEW.kind, NEW.machine_id, NEW.record_id, NEW.service_id, NEW.revision, NEW.deleted, NEW.data)
    ON CONFLICT(kind, machine_id, record_id) DO UPDATE SET
      revision=excluded.revision, deleted=excluded.deleted, data=excluded.data;
END;
