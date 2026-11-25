CREATE TABLE fleet_pin_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pin_hash TEXT NOT NULL,
  generation TEXT NOT NULL
);

CREATE TABLE fleet_trusted_devices (
  device_hash TEXT PRIMARY KEY NOT NULL,
  owner_generation TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE fleet_web_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  device_hash TEXT NOT NULL REFERENCES fleet_trusted_devices(device_hash),
  expires_at INTEGER NOT NULL
);
CREATE INDEX fleet_sessions_device ON fleet_web_sessions(device_hash);

CREATE TABLE fleet_pin_windows (
  bucket TEXT PRIMARY KEY NOT NULL,
  period INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
