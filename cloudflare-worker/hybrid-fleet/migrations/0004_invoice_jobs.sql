CREATE TABLE fleet_invoice_jobs (
  operation_id TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  qr_hash TEXT NOT NULL,
  input TEXT NOT NULL CHECK(json_valid(input)),
  initial_import INTEGER NOT NULL CHECK(initial_import IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','review','already_confirmed')),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  invoice_id TEXT
);
CREATE INDEX fleet_invoice_jobs_available ON fleet_invoice_jobs(status, available_at, lease_until, operation_id);
CREATE INDEX fleet_invoice_jobs_qr ON fleet_invoice_jobs(qr_hash, status) WHERE qr_hash<>'';
CREATE INDEX fleet_invoice_record_qr ON fleet_records(json_extract(data,'$.qrUrl')) WHERE kind='invoice' AND deleted=0;
CREATE INDEX fleet_invoice_record_sha ON fleet_records(json_extract(data,'$.sha256')) WHERE kind='invoice' AND deleted=0;
CREATE INDEX fleet_invoice_record_mark ON fleet_records(json_extract(data,'$.mark')) WHERE kind='invoice' AND deleted=0;

CREATE TABLE fleet_invoice_identity (
  identity TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL REFERENCES fleet_invoice_jobs(operation_id)
);

CREATE TABLE fleet_invoice_stage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  manifest_hash TEXT NOT NULL,
  job_count INTEGER NOT NULL,
  verified_at INTEGER NOT NULL
);
