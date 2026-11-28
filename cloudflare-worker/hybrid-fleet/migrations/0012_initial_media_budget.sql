CREATE TABLE fleet_initial_media_usage (
  id INTEGER PRIMARY KEY CHECK(id=1),
  bytes INTEGER NOT NULL CHECK(bytes>=0)
);
INSERT INTO fleet_initial_media_usage(id,bytes) VALUES(1,0);

CREATE TABLE fleet_initial_media (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL CHECK(size>0)
);

CREATE TRIGGER count_fleet_initial_media AFTER INSERT ON fleet_initial_media
BEGIN
  UPDATE fleet_initial_media_usage SET bytes=bytes+NEW.size WHERE id=1;
END;
