ALTER TABLE passes ADD COLUMN min_altitude_ft REAL;
ALTER TABLE passes ADD COLUMN max_altitude_ft REAL;

CREATE INDEX idx_passes_first_seen_id ON passes(first_seen DESC, id DESC);
PRAGMA optimize;
