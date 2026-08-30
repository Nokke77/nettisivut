CREATE TABLE aircraft_metadata (
  icao TEXT PRIMARY KEY,
  registration TEXT,
  type_code TEXT,
  type_description TEXT,
  owner_operator TEXT,
  is_military INTEGER CHECK (is_military IN (0, 1) OR is_military IS NULL),
  updated_at TEXT NOT NULL
);
