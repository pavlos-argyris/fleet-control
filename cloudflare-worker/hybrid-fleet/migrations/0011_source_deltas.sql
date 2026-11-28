CREATE TABLE fleet_source_deltas (
  cursor INTEGER PRIMARY KEY CHECK(cursor>0),
  epoch TEXT NOT NULL,
  previous INTEGER NOT NULL UNIQUE CHECK(previous>=0 AND previous<cursor),
  manifest TEXT NOT NULL CHECK(json_valid(manifest)),
  verified_at INTEGER
);

CREATE TABLE fleet_source_delta_parts (
  cursor INTEGER NOT NULL REFERENCES fleet_source_deltas(cursor),
  stream TEXT NOT NULL CHECK(stream IN ('records','files')),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  digest TEXT NOT NULL,
  end_offset INTEGER NOT NULL CHECK(end_offset>0),
  chain TEXT NOT NULL,
  data BLOB,
  CHECK((stream='records')=(data IS NOT NULL)),
  PRIMARY KEY(cursor,stream,ordinal)
);

CREATE INDEX fleet_source_files_by_digest ON fleet_source_delta_parts(cursor,digest) WHERE stream='files';

CREATE TABLE fleet_source_projection (
  cursor INTEGER PRIMARY KEY REFERENCES fleet_source_deltas(cursor),
  state TEXT NOT NULL CHECK(state IN ('indexing','indexed','blocked')),
  reason TEXT NOT NULL DEFAULT '',
  next_byte INTEGER NOT NULL DEFAULT 0,
  next_row INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX fleet_source_projection_by_state ON fleet_source_projection(state,cursor);

CREATE TABLE fleet_source_projection_rows (
  cursor INTEGER NOT NULL REFERENCES fleet_source_projection(cursor),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  sha256 TEXT,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  PRIMARY KEY(cursor,kind,machine_id,record_id),
  UNIQUE(cursor,ordinal)
);

CREATE INDEX fleet_source_projection_by_id ON fleet_source_projection_rows(kind,machine_id,record_id,cursor DESC);
