-- Additive only: observations, passes, metadata and daily stats stay intact.
CREATE TABLE route_cache (
  callsign TEXT PRIMARY KEY CHECK (length(callsign) BETWEEN 4 AND 8),
  state TEXT NOT NULL CHECK (state IN ('found', 'missing', 'error')),
  route_json TEXT CHECK (route_json IS NULL OR (json_valid(route_json) AND length(CAST(route_json AS BLOB)) <= 4096)),
  checked_at TEXT NOT NULL,
  retry_after TEXT NOT NULL
);
CREATE INDEX idx_route_cache_retry ON route_cache(retry_after);

-- A single atomic lease also enforces the daily outbound-request budget.
CREATE TABLE route_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  day TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests BETWEEN 0 AND 200),
  lease_id TEXT,
  lease_until TEXT,
  paused_until TEXT
);
INSERT INTO route_budget (id, day, requests) VALUES (1, '1970-01-01', 0);

-- A snapshot belongs to an observed pass, never just an aircraft's ICAO.
CREATE TABLE pass_routes (
  pass_id TEXT PRIMARY KEY REFERENCES passes(id) ON DELETE CASCADE,
  callsign TEXT NOT NULL,
  route_json TEXT NOT NULL CHECK (json_valid(route_json) AND length(CAST(route_json AS BLOB)) <= 4096)
);
