CREATE TABLE fleet_baseline_ledger (
  id INTEGER PRIMARY KEY CHECK(id=1),
  epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('loading','ready','blocked')),
  reason TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  next_row INTEGER NOT NULL DEFAULT 0 CHECK(next_row>=0),
  seeded_rows INTEGER NOT NULL DEFAULT 0 CHECK(seeded_rows>=0)
);

CREATE TABLE fleet_baseline_invoice_identity (
  identity TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  PRIMARY KEY(identity,machine_id,service_id)
);
