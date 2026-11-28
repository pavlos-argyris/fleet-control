CREATE TABLE fleet_baseline_document_links (
  file_key TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  PRIMARY KEY(file_key,machine_id,service_id)
);
