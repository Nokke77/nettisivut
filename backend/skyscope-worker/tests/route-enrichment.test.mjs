import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";
import {
  ROUTE_LIMITS, ROUTE_SOURCE, normalizeCallsign, routeSourceUrl,
  parseSourceRoute, fetchSourceRoute, enrichRecentRoutes, addLiveRoutes
} from "../src/routes.js";

const migrations = ["0001_initial.sql", "0002_aircraft_metadata.sql",
  "0003_pass_altitudes_and_date_index.sql", "0004_route_enrichment.sql"];
const NOW = Date.parse("2026-09-01T14:00:00Z");
const iso = (time) => new Date(time).toISOString();
const passId = (index) => index.toString(16).padStart(64, "0");

// Mirrors the publisher's generate-jsons.py schema. Coordinates are deliberately
// present so tests can verify that route storage does not copy them.
function source(callsign = "FIN6YP", airportCodes = ["EFKU", "EFHK"]) {
  const airports = {
    EFKU: { icao: "EFKU", iata: "KUO", name: "Kuopio Airport", location: "Kuopio / Siilinjärvi" },
    EFHK: { icao: "EFHK", iata: "HEL", name: "Helsinki Vantaa Airport", location: "Helsinki" },
    EGPH: { icao: "EGPH", iata: "EDI", name: "Edinburgh Airport", location: "Edinburgh" },
    ZBAA: { icao: "ZBAA", iata: "PEK", name: "Beijing Capital International Airport", location: "Beijing" }
  };
  return {
    callsign, number: callsign.slice(3), airline_code: callsign.slice(0, 3),
    airport_codes: airportCodes.join("-"),
    _airports: airportCodes.map((code) => ({ ...airports[code], lat: 1.25, lon: 2.5, alt_feet: 15 }))
  };
}

class D1 {
  constructor({ routes = true } = {}) {
    this.sqlite = new DatabaseSync(":memory:");
    for (const name of migrations.slice(0, routes ? 4 : 3)) {
      this.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    this.queries = 0;
  }
  prepare(sql) {
    const db = this;
    return {
      sql, values: [],
      bind(...values) { this.values = values; return this; },
      async first() { db.queries += 1; return db.sqlite.prepare(sql).get(...this.values) ?? null; },
      async all() { db.queries += 1; return { results: db.sqlite.prepare(sql).all(...this.values) }; },
      async run() { db.queries += 1; const info = db.sqlite.prepare(sql).run(...this.values); return { success: true, meta: { changes: info.changes } }; }
    };
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      for (const statement of statements) await statement.run();
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    return statements.map(() => ({ success: true }));
  }
  row(sql, ...values) { return this.sqlite.prepare(sql).get(...values); }
  changes() { return this.row("SELECT total_changes() AS n").n; }
  close() { this.sqlite.close(); }
}

function environment(db) {
  return { DB: db, ROUTE_ENRICHMENT_ENABLED: "true", INGEST_TOKEN: "test-only",
    PRODUCTION_ORIGIN: "https://noeljeromaa.com" };
}

function seedPass(db, { index = 1, callsign = "FIN6YP", now = NOW, icao = "4601F6" } = {}) {
  db.sqlite.prepare(`INSERT INTO passes (id, icao, callsign, first_seen, last_seen, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(passId(index), icao, callsign, iso(now - 60_000), iso(now), iso(now));
}

function seedLive(db, callsigns = ["FIN6YP"], now = NOW) {
  db.sqlite.prepare(`INSERT OR REPLACE INTO receiver_state VALUES (1, ?, ?, ?)`)
    .run(iso(now), iso(now), JSON.stringify(callsigns.map((callsign) => ({ icao: "4601F6", callsign }))));
}

function upstream(data = source()) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return Response.json(typeof data === "function" ? data(url) : data);
  };
  return { calls, fetcher };
}

test("callsign normalization never becomes an arbitrary external URL", () => {
  assert.equal(normalizeCallsign(" fin6yp "), "FIN6YP");
  assert.equal(routeSourceUrl("CHH408"), "https://vrs-standing-data.adsb.lol/routes/CH/CHH408.json");
  for (const bad of ["", null, "N31", "OH-ATI", "../../foo", "FIN 6YP", "FIN123456", "https://example.test", "FIN6YP?x=1"]) {
    assert.equal(normalizeCallsign(bad), null);
    assert.throws(() => routeSourceUrl(bad));
  }
});

test("publisher JSON becomes small, attributed metadata without airport coordinates", () => {
  const route = parseSourceRoute(source(), "FIN6YP", iso(NOW));
  assert.deepEqual(route.airports.map((airport) => airport.iata), ["KUO", "HEL"]);
  assert.equal(route.source_url, ROUTE_SOURCE);
  assert.equal(route.kind, "callsign_database");
  assert.equal(route.fetched_at, iso(NOW));
  assert.equal("lat" in route.airports[0], false);
  assert.equal("lon" in route.airports[0], false);
  assert.ok(new TextEncoder().encode(JSON.stringify(route)).length < 1024);
});

test("malformed, mismatched and incomplete routes cannot produce guessed endpoints", () => {
  const bad = source();
  bad._airports.pop();
  assert.throws(() => parseSourceRoute(bad, "FIN6YP", iso(NOW)));
  assert.throws(() => parseSourceRoute(source("CHH408"), "FIN6YP", iso(NOW)));
  const reversed = source();
  reversed._airports.reverse();
  assert.throws(() => parseSourceRoute(reversed, "FIN6YP", iso(NOW)));
  assert.throws(() => parseSourceRoute({ callsign: "FIN6YP" }, "FIN6YP", iso(NOW)));
});

test("stopovers and airports without IATA codes are preserved", () => {
  const data = source("FIN6YP", ["EFKU", "EFHK", "EGPH"]);
  data._airports[1].iata = "";
  const route = parseSourceRoute(data, "FIN6YP", iso(NOW));
  assert.equal(route.airports.length, 3);
  assert.equal(route.airports[1].iata, null);
  assert.equal(route.airports[1].icao, "EFHK");
});

test("HTTP 404 has a six-hour negative cache, not a guessed route", async () => {
  const result = await fetchSourceRoute("OHU488", NOW, async () => new Response(null, { status: 404 }));
  assert.equal(result.state, "missing");
  assert.equal(result.route, null);
  assert.equal(result.retryAt, NOW + ROUTE_LIMITS.missingTtlMs);
});

test("rate limiting and upstream errors cause global backoff", async () => {
  for (const status of [429, 500, 503]) {
    const result = await fetchSourceRoute("FIN6YP", NOW, async () => new Response(null, { status }));
    assert.equal(result.state, "error");
    assert.ok(Date.parse(result.pauseUntil) >= NOW + 5 * 60_000);
  }
});

test("invalid or oversized upstream bodies are bounded and rejected", async () => {
  for (const makeResponse of [
    () => new Response("<html>not json</html>"),
    () => new Response("x".repeat(ROUTE_LIMITS.responseBytes + 1)),
    () => new Response("{}", { headers: { "Content-Length": String(ROUTE_LIMITS.responseBytes + 1) } }),
    () => Response.json(source("CHH408"))
  ]) {
    const result = await fetchSourceRoute("FIN6YP", NOW, async () => makeResponse());
    assert.equal(result.state, "error");
    assert.equal(result.route, null);
  }
});

test("upstream timeout is enforced across the request", async () => {
  let aborted = false;
  const result = await fetchSourceRoute("FIN6YP", NOW, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  }));
  assert.equal(aborted, true);
  assert.equal(result.state, "error");
});

test("one scheduled lookup stores a route and an immutable pass snapshot", async (t) => {
  const db = new D1(); t.after(() => db.close());
  seedPass(db);
  const provider = upstream();
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher });
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].options.redirect, "error");
  assert.equal(db.row("SELECT requests FROM route_budget").requests, 1);
  assert.equal(db.row("SELECT COUNT(*) n FROM pass_routes").n, 1);
  assert.ok(db.queries < 20, `D1 queries: ${db.queries}`);
  const response = await worker.fetch(new Request("https://example.test/api/passes?date=2026-09-01"), environment(db));
  assert.equal(response.status, 200);
  const pass = (await response.json()).passes[0];
  assert.equal(pass.route.airports[0].iata, "KUO");
  assert.equal("route_json" in pass, false);
});

test("1,440 unchanged scheduled runs neither refetch nor rewrite existing routes", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db);
  const provider = upstream();
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher });
  const changes = db.changes();
  for (let index = 0; index < 1440; index += 1) {
    await enrichRecentRoutes(environment(db), { now: NOW + index * 60_000, fetcher: provider.fetcher });
  }
  assert.equal(provider.calls.length, 1);
  assert.equal(db.changes(), changes);
});

test("negative cache prevents repeated requests for an unknown callsign", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db, { callsign: "OHU488" });
  let requests = 0;
  const fetcher = async () => { requests += 1; return new Response(null, { status: 404 }); };
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher });
  const changes = db.changes();
  for (let index = 1; index < 100; index += 1) {
    await enrichRecentRoutes(environment(db), { now: NOW + index * 60_000, fetcher });
  }
  assert.equal(requests, 1);
  assert.equal(db.changes(), changes);
  assert.equal(db.row("SELECT COUNT(*) n FROM pass_routes").n, 0);
});

test("known cached route is reused for a new pass without an outbound request", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db);
  const provider = upstream();
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher });
  seedPass(db, { index: 2, now: NOW + 60_000 });
  await enrichRecentRoutes(environment(db), { now: NOW + 60_000, fetcher: provider.fetcher });
  assert.equal(provider.calls.length, 1);
  assert.equal(db.row("SELECT COUNT(*) n FROM pass_routes").n, 2);
});

test("a later reuse of a callsign cannot rewrite an earlier flight route", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db);
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: upstream().fetcher });
  const saved = db.row("SELECT route_json FROM pass_routes WHERE pass_id = ?", passId(1)).route_json;
  const later = NOW + 25 * 60 * 60_000;
  seedPass(db, { index: 2, now: later });
  await enrichRecentRoutes(environment(db), { now: later, fetcher: upstream(source("FIN6YP", ["EFHK", "EGPH"])).fetcher });
  assert.equal(db.row("SELECT route_json FROM pass_routes WHERE pass_id = ?", passId(1)).route_json, saved);
  assert.equal(JSON.parse(db.row("SELECT route_json FROM pass_routes WHERE pass_id = ?", passId(2)).route_json).airports[1].iata, "EDI");
});

test("a changed pass callsign hides the old route until a matching route is found", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db);
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: upstream().fetcher });
  db.sqlite.prepare("UPDATE passes SET callsign = 'CHH408' WHERE id = ?").run(passId(1));
  const response = await worker.fetch(new Request("https://example.test/api/passes"), environment(db));
  assert.equal((await response.json()).passes[0].route, null);
  await enrichRecentRoutes(environment(db), { now: NOW + 60_000, fetcher: upstream(source("CHH408", ["EGPH", "ZBAA"])).fetcher });
  assert.equal(db.row("SELECT callsign FROM pass_routes").callsign, "CHH408");
});

test("old historical observations are not backfilled with today's source data", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db, { now: NOW - 3 * 86400_000 });
  const provider = upstream();
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher });
  assert.equal(provider.calls.length, 0);
  assert.equal(db.row("SELECT COUNT(*) n FROM pass_routes").n, 0);
});

test("daily budget is capped atomically and resets on the next UTC date", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db);
  db.sqlite.prepare("UPDATE route_budget SET day = '2026-09-01', requests = 200").run();
  const provider = upstream();
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher });
  assert.equal(provider.calls.length, 0);
  await enrichRecentRoutes(environment(db), { now: NOW + 86400_000, fetcher: provider.fetcher });
  assert.equal(provider.calls.length, 1);
  assert.equal(db.row("SELECT requests FROM route_budget").requests, 1);
});

test("overlapping scheduler runs make only one request for the same work", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db);
  const provider = upstream();
  await Promise.all(Array.from({ length: 5 }, () => enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher })));
  assert.equal(provider.calls.length, 1);
  assert.equal(db.row("SELECT requests FROM route_budget").requests, 1);
});

test("cache capacity is bounded and cleanup never deletes pass history", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db);
  const insert = db.sqlite.prepare("INSERT INTO route_cache VALUES (?, 'missing', NULL, ?, ?)");
  for (let index = 0; index < ROUTE_LIMITS.cacheEntries; index += 1) insert.run(`TST${index}`, iso(NOW), iso(NOW + 86400_000));
  const provider = upstream();
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher });
  assert.equal(provider.calls.length, 0);
  assert.equal(db.row("SELECT COUNT(*) n FROM route_cache").n, 2000);
  db.sqlite.exec("UPDATE route_cache SET retry_after = '2026-01-01T00:00:00.000Z' WHERE callsign = 'TST0'");
  await enrichRecentRoutes(environment(db), { now: NOW + 60_000, fetcher: provider.fetcher });
  assert.equal(provider.calls.length, 1);
  assert.equal(db.row("SELECT COUNT(*) n FROM route_cache").n, 2000);
  assert.equal(db.row("SELECT COUNT(*) n FROM passes").n, 1);
});

test("global source backoff prevents a failure storm across different callsigns", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedPass(db);
  seedPass(db, { index: 2, callsign: "FIN5ET" });
  let requests = 0;
  const fetcher = async () => { requests += 1; return new Response(null, { status: 429 }); };
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher });
  await enrichRecentRoutes(environment(db), { now: NOW + 60_000, fetcher });
  assert.equal(requests, 1);
  assert.equal(db.row("SELECT lease_id FROM route_budget").lease_id, null);
});

test("live aircraft receive only fresh cached routes and never start external lookups", async (t) => {
  const db = new D1(); t.after(() => db.close()); seedLive(db);
  const provider = upstream();
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher });
  const aircraft = [{ callsign: "FIN6YP", icao: "4601F6" }];
  const live = await addLiveRoutes(db, aircraft, iso(NOW), NOW);
  assert.equal(live[0].route.airports[0].iata, "KUO");
  assert.equal((await addLiveRoutes(db, aircraft, iso(NOW), NOW + 86400_000))[0].route, undefined);
  assert.equal(provider.calls.length, 1);
});

test("disabled feature performs no route queries or source requests", async (t) => {
  const db = new D1({ routes: false }); t.after(() => db.close()); seedPass(db);
  const before = db.changes();
  const provider = upstream();
  await enrichRecentRoutes({ DB: db }, { now: NOW, fetcher: provider.fetcher });
  assert.equal(db.queries, 0);
  assert.equal(db.changes(), before);
  assert.equal(provider.calls.length, 0);
});

test("missing route migration cannot hide existing public passes", async (t) => {
  const db = new D1({ routes: false }); t.after(() => db.close()); seedPass(db);
  const response = await worker.fetch(new Request("https://example.test/api/passes"), environment(db));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).passes.length, 1);
});

test("ingest stays independent of route fetches and route tables", async (t) => {
  const db = new D1({ routes: false }); t.after(() => db.close());
  const response = await worker.fetch(new Request("https://example.test/api/ingest", {
    method: "POST", headers: { Authorization: "Bearer test-only", "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, captured_at: iso(NOW), aircraft: [], passes: [],
      stats: { date: "2026-09-01", unique_aircraft_count: 0, pass_count: 0, closest_aircraft: null } })
  }), environment(db));
  assert.equal(response.status, 202);
  assert.equal(db.row("SELECT captured_at FROM receiver_state").captured_at, iso(NOW));
});

test("each job has a single outbound request even with many unmatched flights", async (t) => {
  const db = new D1(); t.after(() => db.close());
  for (let index = 1; index <= 100; index += 1) seedPass(db, { index, callsign: `FIN${index}` });
  const provider = upstream((url) => source(url.split("/").at(-1).replace(".json", "")));
  await enrichRecentRoutes(environment(db), { now: NOW, fetcher: provider.fetcher });
  assert.equal(provider.calls.length, 1);
  assert.ok(db.queries < 20);
});

test("migration 0004 preserves pre-existing pass rows and timestamps", (t) => {
  const db = new D1({ routes: false }); t.after(() => db.close()); seedPass(db);
  const before = db.row("SELECT * FROM passes WHERE id = ?", passId(1));
  db.sqlite.exec(readFileSync(new URL("../migrations/0004_route_enrichment.sql", import.meta.url), "utf8"));
  assert.deepEqual(db.row("SELECT * FROM passes WHERE id = ?", passId(1)), before);
});

test("live API uses route cache while an unavailable route table preserves the aircraft", async (t) => {
  const db = new D1(); t.after(() => db.close());
  const now = Date.now(); seedLive(db, ["FIN6YP"], now);
  await enrichRecentRoutes(environment(db), { now, fetcher: upstream().fetcher });
  let response = await worker.fetch(new Request("https://example.test/api/live"), environment(db));
  assert.equal((await response.json()).aircraft[0].route.airports[0].iata, "KUO");
  const legacy = new D1({ routes: false }); t.after(() => legacy.close()); seedLive(legacy, ["FIN6YP"], now);
  response = await worker.fetch(new Request("https://example.test/api/live"), environment(legacy));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).aircraft[0].callsign, "FIN6YP");
});

test("source timeout also covers a stalled response body", async () => {
  const result = await fetchSourceRoute("FIN6YP", NOW, async (_url, { signal }) => {
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(new Error("body aborted")));
      }
    });
    return new Response(body);
  });
  assert.equal(result.state, "error");
});

test("all ten observed flights are eventually enriched one by one", async (t) => {
  const db = new D1(); t.after(() => db.close());
  for (let index = 1; index <= 10; index += 1) seedPass(db, { index, callsign: `FIN${index}` });
  const provider = upstream((url) => source(url.split("/").at(-1).replace(".json", "")));
  for (let index = 0; index < 10; index += 1) {
    await enrichRecentRoutes(environment(db), { now: NOW + index * 60_000, fetcher: provider.fetcher });
  }
  assert.equal(provider.calls.length, 10);
  assert.equal(db.row("SELECT COUNT(*) n FROM pass_routes").n, 10);
  const response = await worker.fetch(new Request("https://example.test/api/passes?date=2026-09-01"), environment(db));
  const passes = (await response.json()).passes;
  assert.equal(passes.length, 10);
  assert.equal(passes.every((pass) => pass.route?.airports.length === 2), true);
});
