CREATE TABLE receiver_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  aircraft_json TEXT NOT NULL CHECK (json_valid(aircraft_json))
);

CREATE TABLE passes (
  id TEXT PRIMARY KEY,
  icao TEXT NOT NULL,
  callsign TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  closest_distance_km REAL,
  closest_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_passes_last_seen ON passes(last_seen DESC);
CREATE INDEX idx_passes_icao_last_seen ON passes(icao, last_seen DESC);

CREATE TABLE daily_stats (
  date TEXT PRIMARY KEY,
  unique_aircraft_count INTEGER NOT NULL CHECK (unique_aircraft_count >= 0),
  pass_count INTEGER NOT NULL CHECK (pass_count >= 0),
  closest_icao TEXT,
  closest_callsign TEXT,
  closest_distance_km REAL,
  closest_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_daily_stats_updated_at ON daily_stats(updated_at DESC);
