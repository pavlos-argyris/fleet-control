CREATE TABLE fleet_baseline_projection (
  id INTEGER PRIMARY KEY CHECK(id=1),
  epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('indexing','verified','blocked')),
  reason TEXT NOT NULL DEFAULT '',
  next_byte INTEGER NOT NULL DEFAULT 0 CHECK(next_byte>=0),
  next_row INTEGER NOT NULL DEFAULT 0 CHECK(next_row>=0),
  documents INTEGER NOT NULL DEFAULT 0 CHECK(documents>=0)
);

CREATE TABLE fleet_baseline_rows (
  ordinal INTEGER PRIMARY KEY CHECK(ordinal>=0),
  kind TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  start_byte INTEGER NOT NULL UNIQUE CHECK(start_byte>=0),
  end_byte INTEGER NOT NULL CHECK(end_byte>start_byte),
  digest TEXT NOT NULL,
  details TEXT NOT NULL CHECK(json_valid(details)),
  UNIQUE(kind,machine_id,record_id)
);
