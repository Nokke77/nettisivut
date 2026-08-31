import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { helsinkiDateRange } from "../src/worker.js";

const initialMigration = readFileSync(
  new URL("../migrations/0001_initial.sql", import.meta.url),
  "utf8"
);
const metadataMigration = readFileSync(
  new URL("../migrations/0002_aircraft_metadata.sql", import.meta.url),
  "utf8"
);
const passDetailsMigration = readFileSync(
  new URL("../migrations/0003_pass_altitudes_and_date_index.sql", import.meta.url),
  "utf8"
);
const migration = `${initialMigration}\n${metadataMigration}\n${passDetailsMigration}`;

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
    registration: "OH-ATI", type_code: "AT75", type_description: "ATR 72-500",
    owner_operator: "Finnair Oyj", is_military: false,
    altitude_ft: 12000, speed_knots: 310, track_deg: 180, signal_db: -12.5,
    distance_km: 14.2, messages: 100, seen_at: "2026-08-30T09:59:59Z"
  }],
  passes: [{
    id: passId, icao: "ABC123", callsign: "FIN123",
    first_seen: "2026-08-30T09:45:00Z", last_seen: "2026-08-30T10:00:00Z",
    closest_distance_km: 10.5, closest_at: "2026-08-30T09:55:00Z",
    min_altitude_ft: 9000, max_altitude_ft: 12000
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

function metadataRow(database) {
  return database.row("SELECT * FROM aircraft_metadata WHERE icao = ?", "ABC123");
}

test("additive migrations preserve existing production tables and rows", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(initialMigration);
    sqlite.prepare(`
      INSERT INTO passes (
        id, icao, callsign, first_seen, last_seen,
        closest_distance_km, closest_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      passId,
      "ABC123",
      "FIN123",
      "2026-08-30T09:45:00.000Z",
      "2026-08-30T10:00:00.000Z",
      10.5,
      "2026-08-30T09:55:00.000Z",
      "2026-08-30T10:00:00.000Z"
    );

    sqlite.exec(metadataMigration);
    sqlite.exec(passDetailsMigration);

    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM passes").get().count,
      1
    );
    const altitudeColumns = sqlite.prepare(
      "SELECT min_altitude_ft, max_altitude_ft FROM passes WHERE id = ?"
    ).get(passId);
    assert.equal(altitudeColumns.min_altitude_ft, null);
    assert.equal(altitudeColumns.max_altitude_ft, null);
    assert.equal(
      sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_passes_first_seen_id'
      `).get().count,
      1
    );
    assert.equal(
      sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'aircraft_metadata'
      `).get().count,
      1
    );
  } finally {
    sqlite.close();
  }
});

test("first snapshot inserts a pass and daily stats", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());

  await ingest(database, clonePayload());

  assert.equal(passRow(database).last_seen, "2026-08-30T10:00:00.000Z");
  assert.equal(statsRow(database).pass_count, 1);
  assert.equal(metadataRow(database).type_description, "ATR 72-500");
  assert.equal(metadataRow(database).is_military, 0);
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

test("new aircraft metadata is stored and later completed", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const sparse = clonePayload();
  sparse.aircraft[0].registration = null;
  sparse.aircraft[0].type_code = null;
  sparse.aircraft[0].type_description = null;
  sparse.aircraft[0].owner_operator = null;
  sparse.aircraft[0].is_military = null;
  await ingest(database, sparse);
  assert.equal(metadataRow(database), null);

  const complete = clonePayload();
  complete.captured_at = "2026-08-30T10:05:00Z";
  complete.passes = [];
  await ingest(database, complete);

  assert.equal(metadataRow(database).registration, "OH-ATI");
  assert.equal(metadataRow(database).owner_operator, "Finnair Oyj");
});

test("missing metadata never erases known aircraft identity", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const sparse = clonePayload();
  sparse.captured_at = "2026-08-30T10:05:00Z";
  sparse.passes = [];
  sparse.aircraft[0].registration = null;
  sparse.aircraft[0].type_code = null;
  sparse.aircraft[0].type_description = null;
  sparse.aircraft[0].owner_operator = null;
  sparse.aircraft[0].is_military = null;

  await ingest(database, sparse);

  assert.equal(metadataRow(database).registration, "OH-ATI");
  assert.equal(metadataRow(database).owner_operator, "Finnair Oyj");
});

test("older metadata cannot replace a newer aircraft identity", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const newer = clonePayload();
  newer.captured_at = "2026-08-30T10:05:00Z";
  newer.aircraft[0].owner_operator = "Current operator";
  await ingest(database, newer);
  const older = clonePayload();
  older.captured_at = "2026-08-30T10:00:00Z";
  older.passes = [];
  older.aircraft[0].owner_operator = "Old operator";

  await ingest(database, older);

  assert.equal(metadataRow(database).owner_operator, "Current operator");
  assert.equal(metadataRow(database).updated_at, "2026-08-30T10:05:00.000Z");
});

test("pass and daily-stat APIs join aircraft identity metadata", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const env = environment(database);

  const passesResponse = await worker.fetch(
    new Request("https://api.example.test/api/passes"),
    env
  );
  const statsResponse = await worker.fetch(
    new Request("https://api.example.test/api/stats"),
    env
  );
  const passes = await passesResponse.json();
  const stats = await statsResponse.json();

  assert.equal(passes.passes[0].type_code, "AT75");
  assert.equal(passes.passes[0].is_military, false);
  assert.equal(stats.closest_aircraft.type_description, "ATR 72-500");
  assert.equal(stats.closest_aircraft.owner_operator, "Finnair Oyj");
});

test("pass altitude range only expands when new observations improve it", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  await ingest(database, clonePayload());
  const originalUpdatedAt = passRow(database).updated_at;
  const unchanged = clonePayload();
  unchanged.captured_at = "2026-08-30T10:05:00Z";
  unchanged.stats = clonePayload().stats;
  await ingest(database, unchanged);
  assert.equal(passRow(database).updated_at, originalUpdatedAt);

  const expanded = clonePayload();
  expanded.captured_at = "2026-08-30T10:10:00Z";
  expanded.passes[0].min_altitude_ft = 8000;
  expanded.passes[0].max_altitude_ft = 13000;
  const changesBeforeExpansion = database.totalChanges();
  await ingest(database, expanded);

  assert.equal(database.totalChanges() - changesBeforeExpansion, 2);
  assert.equal(passRow(database).min_altitude_ft, 8000);
  assert.equal(passRow(database).max_altitude_ft, 13000);
});

test("Helsinki day boundaries account for daylight-saving changes", () => {
  assert.deepEqual(helsinkiDateRange("2026-03-29"), {
    start: "2026-03-28T22:00:00.000Z",
    end: "2026-03-29T21:00:00.000Z"
  });
  assert.deepEqual(helsinkiDateRange("2026-10-25"), {
    start: "2026-10-24T21:00:00.000Z",
    end: "2026-10-25T22:00:00.000Z"
  });
});

test("date-filtered pass API paginates the entire selected Helsinki day", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const insert = database.sqlite.prepare(`
    INSERT INTO passes (
      id, icao, callsign, first_seen, last_seen,
      closest_distance_km, closest_at, min_altitude_ft,
      max_altitude_ft, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 125; index += 1) {
    const id = index.toString(16).padStart(64, "0");
    insert.run(
      id, "ABC123", `FIN${index}`,
      "2026-08-30T10:00:00.000Z", "2026-08-30T10:05:00.000Z",
      10, "2026-08-30T10:03:00.000Z", 9000, 12000,
      "2026-08-30T10:05:00.000Z"
    );
  }
  insert.run(
    "f".repeat(64), "OUT123", "OUT1",
    "2026-08-29T20:59:59.000Z", "2026-08-29T21:00:00.000Z",
    null, null, null, null, "2026-08-29T21:00:00.000Z"
  );

  const defaultPageResponse = await worker.fetch(
    new Request("https://api.example.test/api/passes?date=2026-08-30"),
    environment(database)
  );
  const defaultPage = await defaultPageResponse.json();
  assert.equal(defaultPage.passes.length, 100);
  assert.equal(typeof defaultPage.next_cursor, "string");

  const collected = [];
  let cursor = null;
  do {
    const search = new URLSearchParams({ date: "2026-08-30", limit: "50" });
    if (cursor) search.set("cursor", cursor);
    const response = await worker.fetch(
      new Request(`https://api.example.test/api/passes?${search}`),
      environment(database)
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    collected.push(...page.passes);
    cursor = page.next_cursor;
  } while (cursor);

  assert.equal(collected.length, 125);
  assert.equal(new Set(collected.map((pass) => pass.id)).size, 125);
  assert.equal(collected.some((pass) => pass.icao === "OUT123"), false);
  assert.equal(collected[0].min_altitude_ft, 9000);
});

test("date-filtered pass API rejects invalid dates and cursors", async (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const env = environment(database);

  const invalidDate = await worker.fetch(
    new Request("https://api.example.test/api/passes?date=2026-02-30"), env
  );
  const invalidCursor = await worker.fetch(
    new Request("https://api.example.test/api/passes?date=2026-08-30&cursor=not-valid"), env
  );

  assert.equal(invalidDate.status, 400);
  assert.equal(invalidCursor.status, 400);
});

test("selected-day pass query uses the dedicated first_seen index", (t) => {
  const database = new SqliteD1();
  t.after(() => database.close());
  const plan = database.sqlite.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM passes
    WHERE first_seen >= ? AND first_seen < ?
    ORDER BY first_seen DESC, id DESC
    LIMIT ?
  `).all("2026-08-29T21:00:00.000Z", "2026-08-30T21:00:00.000Z", 101);

  assert.equal(
    plan.some((step) => step.detail.includes("idx_passes_first_seen_id")),
    true
  );
});
