import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.sql.includes("FROM receiver_state")) return this.database.receiver;
    if (this.sql.includes("FROM daily_stats")) {
      const stats = this.sql.includes("WHERE s.date = ?")
        ? this.database.stats.get(this.values[0]) || null
        : [...this.database.stats.values()].sort((a, b) => b.date.localeCompare(a.date))[0] || null;
      if (!stats) return null;
      return { ...stats, ...(this.database.aircraftMetadata.get(stats.closest_icao) || {}) };
    }
    return null;
  }

  async all() {
    if (!this.sql.includes("FROM passes")) return { results: [] };
    return {
      results: [...this.database.passes.values()]
        .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
        .slice(0, this.values[0])
        .map((pass) => ({
          ...pass,
          ...(this.database.aircraftMetadata.get(pass.icao) || {})
        }))
    };
  }
}

class FakeD1 {
  constructor() {
    this.receiver = null;
    this.passes = new Map();
    this.stats = new Map();
    this.aircraftMetadata = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) {
      const values = statement.values;
      if (statement.sql.startsWith("INSERT INTO receiver_state")) {
        this.receiver = { captured_at: values[0], received_at: values[1], aircraft_json: values[2] };
      } else if (statement.sql.startsWith("INSERT INTO aircraft_metadata")) {
        this.aircraftMetadata.set(values[0], {
          registration: values[1],
          type_code: values[2],
          type_description: values[3],
          owner_operator: values[4],
          is_military: values[5],
          updated_at: values[6]
        });
      } else if (statement.sql.startsWith("INSERT INTO passes")) {
        this.passes.set(values[0], {
          id: values[0], icao: values[1], callsign: values[2], first_seen: values[3],
          last_seen: values[4], closest_distance_km: values[5], closest_at: values[6], updated_at: values[7]
        });
      } else if (statement.sql.startsWith("INSERT INTO daily_stats")) {
        this.stats.set(values[0], {
          date: values[0], unique_aircraft_count: values[1], pass_count: values[2],
          closest_icao: values[3], closest_callsign: values[4], closest_distance_km: values[5],
          closest_at: values[6], updated_at: values[7]
        });
      }
    }
    return statements.map(() => ({ success: true }));
  }
}

const passId = "a".repeat(64);
const validPayload = {
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
    closest_distance_km: 10.5, closest_at: "2026-08-30T09:55:00Z"
  }],
  stats: {
    date: "2026-08-30", unique_aircraft_count: 1, pass_count: 1,
    closest_aircraft: { icao: "ABC123", callsign: "FIN123", distance_km: 10.5, at: "2026-08-30T09:55:00Z" }
  }
};

function environment(database = new FakeD1()) {
  return {
    DB: database,
    INGEST_TOKEN: "test-token",
    PRODUCTION_ORIGIN: "https://noeljeromaa.com",
    LOCAL_DEV_ORIGIN: "http://localhost:8000"
  };
}

function ingestRequest(body, token = "test-token") {
  return new Request("https://api.example.test/api/ingest", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body
  });
}

test("ingest requires a valid bearer token", async () => {
  const response = await worker.fetch(ingestRequest(JSON.stringify(validPayload), "wrong-token"), environment());
  assert.equal(response.status, 401);
});

test("ingest rejects malformed JSON without leaking parser details", async () => {
  const response = await worker.fetch(ingestRequest("{not-json"), environment());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Malformed JSON" });
});

test("ingest rejects a non-boolean military classification", async () => {
  const payload = structuredClone(validPayload);
  payload.aircraft[0].is_military = 1;
  const response = await worker.fetch(
    ingestRequest(JSON.stringify(payload)),
    environment()
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid payload" });
});

test("ingest is idempotent for an existing pass id", async () => {
  const database = new FakeD1();
  const env = environment(database);
  const first = await worker.fetch(ingestRequest(JSON.stringify(validPayload)), env);
  const second = await worker.fetch(ingestRequest(JSON.stringify(validPayload)), env);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(database.passes.size, 1);
  assert.equal(database.aircraftMetadata.size, 1);
  assert.equal(database.passes.get(passId).icao, "ABC123");
});

test("ingest remains compatible with the previous exporter payload", async () => {
  const payload = structuredClone(validPayload);
  for (const field of [
    "registration",
    "type_code",
    "type_description",
    "owner_operator",
    "is_military"
  ]) {
    delete payload.aircraft[0][field];
  }
  const database = new FakeD1();
  const response = await worker.fetch(
    ingestRequest(JSON.stringify(payload)),
    environment(database)
  );
  assert.equal(response.status, 202);
  assert.equal(database.aircraftMetadata.size, 0);
  assert.equal(database.passes.size, 1);
});

test("public responses include stored aircraft identity metadata", async () => {
  const database = new FakeD1();
  const env = environment(database);
  await worker.fetch(ingestRequest(JSON.stringify(validPayload)), env);

  const live = await worker.fetch(new Request("https://api.example.test/api/live"), env);
  const passes = await worker.fetch(new Request("https://api.example.test/api/passes"), env);
  const stats = await worker.fetch(new Request("https://api.example.test/api/stats"), env);

  assert.equal((await live.json()).aircraft[0].type_description, "ATR 72-500");
  assert.equal((await passes.json()).passes[0].owner_operator, "Finnair Oyj");
  assert.equal((await stats.json()).closest_aircraft.registration, "OH-ATI");
});

test("CORS allows only configured origins", async () => {
  const allowed = await worker.fetch(new Request("https://api.example.test/api/status", {
    headers: { Origin: "https://noeljeromaa.com" }
  }), environment());
  const denied = await worker.fetch(new Request("https://api.example.test/api/status", {
    headers: { Origin: "https://attacker.example" }
  }), environment());
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://noeljeromaa.com");
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});
