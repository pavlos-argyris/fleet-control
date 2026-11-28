CREATE TABLE fleet_baseline (
  id INTEGER PRIMARY KEY CHECK(id=1),
  epoch TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK(json_valid(manifest)),
  verified_at INTEGER
);

CREATE TABLE fleet_baseline_parts (
  stream TEXT NOT NULL CHECK(stream IN ('records','files')),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  digest TEXT NOT NULL,
  end_offset INTEGER NOT NULL CHECK(end_offset>0),
  chain TEXT NOT NULL,
  data BLOB,
  CHECK((stream='records')=(data IS NOT NULL)),
  PRIMARY KEY(stream,ordinal)
);
