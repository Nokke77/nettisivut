import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";

const migration = readFileSync(
  new URL("../migrations/0001_initial.sql", import.meta.url),
  "utf8"
);

class SqliteStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.sqlite.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.sqlite.prepare(this.sql).all(...this.values) };
  }
}

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(migration);
  }

  prepare(sql) {
    return new SqliteStatement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        this.sqlite.prepare(statement.sql).run(...statement.values);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }

  row(sql, ...values) {
    return this.sqlite.prepare(sql).get(...values) ?? null;
  }

  totalChanges() {
    return this.row("SELECT total_changes() AS count").count;
  }

  close() {
    this.sqlite.close();
  }
}

const passId = "b".repeat(64);
const basePayload = {
  schema_version: 1,
  captured_at: "2026-08-30T10:00:00Z",
  aircraft: [{
    icao: "ABC123", callsign: "FIN123", latitude: 62.9, longitude: 27.7,
    altitude_ft: 12000, speed_knots: 310, track_deg: 180, signal_db: -12.5,
    distance_km: 14.2, messages: 100, seen_at: "2026-08-30T09:59:59Z"
  }],
  passes: [{
    id: passId, icao: "ABC123", callsign: "FIN123",
    first_seen: "2026-08-30T09:45:00Z", last_seen: "2026-08-30T10:00:00Z",
    closest_distance_km: 10.5, closest_at: "2026-08-30T09:55:00Z"
  }],
  stats: {
    date: "2026-08-30", unique_aircraft_count: 1, pass_count: 1,
    closest_aircraft: {
      icao: "ABC123", callsign: "FIN123", distance_km: 10.5,
      at: "2026-08-30T09:55:00Z"
    }
  }
};

function environment(database) {
  return {
    DB: database,
    INGEST_TOKEN: "test-token",
    PRODUCTION_ORIGIN: "https://noeljeromaa.com",
    LOCAL_DEV_ORIGIN: "http://localhost:8000"
  };
}

function clonePayload() {
  return structuredClone(basePayload);
}

async function ingest(database, payload) {
  const response = await worker.fetch(new Request("https://api.example.test/api/ingest", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }), environment(database));
  assert.equal(response.status, 202);
}

function passRow(database) {
  return database.row("SELECT * FROM passes WHERE id = ?", passId);
}

function statsRow(database) {
  return database.row("SELECT * FROM daily_stats WHERE date = ?", basePayload.stats.date);
}

test("first snapshot inserts a pass and daily stats", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());

  await ingest(database, clonePayload());

  assert.equal(passRow(database).last_seen, "2026-08-30T10:00:00.000Z");
  assert.equal(statsRow(database).pass_count, 1);
});

test("identical snapshot only updates receiver_state", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const payload = clonePayload();
  await ingest(database, payload);
  const passUpdatedAt = passRow(database).updated_at;
  const statsUpdatedAt = statsRow(database).updated_at;
  const changesBefore = database.totalChanges();

  await ingest(database, payload);

  assert.equal(database.totalChanges() - changesBefore, 1);
  assert.equal(passRow(database).updated_at, passUpdatedAt);
  assert.equal(statsRow(database).updated_at, statsUpdatedAt);
});

test("later last_seen updates an existing pass", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const later = clonePayload();
  later.captured_at = "2026-08-30T10:05:00Z";
  later.passes[0].last_seen = "2026-08-30T10:05:00Z";

  await ingest(database, later);

  assert.equal(passRow(database).last_seen, "2026-08-30T10:05:00.000Z");
});

test("earlier first_seen updates an existing pass", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const earlier = clonePayload();
  earlier.captured_at = "2026-08-30T10:05:00Z";
  earlier.passes[0].first_seen = "2026-08-30T09:40:00Z";

  await ingest(database, earlier);

  assert.equal(passRow(database).first_seen, "2026-08-30T09:40:00.000Z");
});

test("smaller closest distance updates distance and matching time", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const closer = clonePayload();
  closer.captured_at = "2026-08-30T10:05:00Z";
  closer.passes[0].closest_distance_km = 8.25;
  closer.passes[0].closest_at = "2026-08-30T10:02:00Z";

  await ingest(database, closer);

  assert.equal(passRow(database).closest_distance_km, 8.25);
  assert.equal(passRow(database).closest_at, "2026-08-30T10:02:00.000Z");
});

test("first available closest distance completes an existing pass", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const missingDistance = clonePayload();
  missingDistance.passes[0].closest_distance_km = null;
  missingDistance.passes[0].closest_at = null;
  await ingest(database, missingDistance);
  const completed = clonePayload();
  completed.captured_at = "2026-08-30T10:05:00Z";

  await ingest(database, completed);

  assert.equal(passRow(database).closest_distance_km, 10.5);
  assert.equal(passRow(database).closest_at, "2026-08-30T09:55:00.000Z");
});

test("new non-empty callsign completes an existing pass", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const missingCallsign = clonePayload();
  missingCallsign.passes[0].callsign = null;
  await ingest(database, missingCallsign);
  assert.equal(passRow(database).callsign, null);
  const completed = clonePayload();
  completed.captured_at = "2026-08-30T10:05:00Z";

  await ingest(database, completed);

  assert.equal(passRow(database).callsign, "FIN123");
});

test("changed non-empty callsign replaces the previous callsign", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const changed = clonePayload();
  changed.captured_at = "2026-08-30T10:05:00Z";
  changed.passes[0].callsign = "FIN124";

  await ingest(database, changed);

  assert.equal(passRow(database).callsign, "FIN124");
});

test("missing incoming callsign preserves the existing callsign", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const missing = clonePayload();
  missing.captured_at = "2026-08-30T10:05:00Z";
  missing.passes[0].callsign = null;

  await ingest(database, missing);

  assert.equal(passRow(database).callsign, "FIN123");
});

test("changed daily count updates daily stats", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const changed = clonePayload();
  changed.captured_at = "2026-08-30T10:05:00Z";
  changed.stats.unique_aircraft_count = 2;
  changed.stats.pass_count = 2;

  await ingest(database, changed);

  assert.equal(statsRow(database).unique_aircraft_count, 2);
  assert.equal(statsRow(database).pass_count, 2);
  assert.equal(statsRow(database).updated_at, "2026-08-30T10:05:00.000Z");
});

test("unchanged daily stats do not update even with a newer snapshot", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const originalUpdatedAt = statsRow(database).updated_at;
  const newer = clonePayload();
  newer.captured_at = "2026-08-30T10:05:00Z";
  newer.passes = [];
  const changesBefore = database.totalChanges();

  await ingest(database, newer);

  assert.equal(database.totalChanges() - changesBefore, 1);
  assert.equal(statsRow(database).updated_at, originalUpdatedAt);
});

test("older daily stats cannot replace a newer snapshot", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const newer = clonePayload();
  newer.captured_at = "2026-08-30T10:05:00Z";
  newer.stats.unique_aircraft_count = 2;
  newer.stats.pass_count = 2;
  await ingest(database, newer);
  const older = clonePayload();
  older.captured_at = "2026-08-30T09:55:00Z";
  older.passes = [];
  older.stats.unique_aircraft_count = 9;
  older.stats.pass_count = 9;
  const changesBefore = database.totalChanges();

  await ingest(database, older);

  assert.equal(database.totalChanges() - changesBefore, 0);
  assert.equal(statsRow(database).unique_aircraft_count, 2);
  assert.equal(statsRow(database).pass_count, 2);
  assert.equal(statsRow(database).updated_at, "2026-08-30T10:05:00.000Z");
});

test("receiver_state continues to update for newer snapshots", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const newer = clonePayload();
  newer.captured_at = "2026-08-30T10:05:00Z";
  newer.passes = [];

  await ingest(database, newer);

  const receiver = database.row("SELECT * FROM receiver_state WHERE id = 1");
  assert.equal(receiver.captured_at, "2026-08-30T10:05:00.000Z");
});
