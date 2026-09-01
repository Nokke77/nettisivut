// CC0 VRS standing-data, served as small per-callsign JSON by ADSB.lol.
// No requests from the Pi or from public API handlers. See docs/skyscope-routes.md.
export const ROUTE_LIMITS = Object.freeze({
  requestsPerUtcDay: 200,
  cacheEntries: 2000,
  responseBytes: 16 * 1024,
  timeoutMs: 4000,
  recentPasses: 100,
  snapshotBatch: 20,
  foundTtlMs: 24 * 60 * 60 * 1000,
  missingTtlMs: 6 * 60 * 60 * 1000,
  errorTtlMs: 15 * 60 * 1000,
  recentWindowMs: 48 * 60 * 60 * 1000
});
export const ROUTE_SOURCE = "https://github.com/vradarserver/standing-data";
const SOURCE_BASE = "https://vrs-standing-data.adsb.lol/routes/";
const iso = (epoch) => new Date(epoch).toISOString();

export function routesEnabled(env) {
  return env.ROUTE_ENRICHMENT_ENABLED === "true";
}

export function normalizeCallsign(value) {
  if (typeof value !== "string") return null;
  const callsign = value.trim().toUpperCase();
  // Do not guess an airline for registrations, military tactical IDs or malformed IDs.
  return /^[A-Z]{3}[0-9][A-Z0-9]{0,4}$/.test(callsign) ? callsign : null;
}

export function routeSourceUrl(value) {
  const callsign = normalizeCallsign(value);
  if (!callsign) throw new TypeError("Invalid route callsign");
  return `${SOURCE_BASE}${callsign.slice(0, 2)}/${callsign}.json`;
}

function shortText(value, maximum = 120) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

export function parseSourceRoute(value, callsign, fetchedAt) {
  if (!value || value.callsign !== callsign || !normalizeCallsign(callsign)) {
    throw new TypeError("Route identity mismatch");
  }
  const codes = typeof value.airport_codes === "string" ? value.airport_codes.split("-") : [];
  if (codes.length < 2 || codes.length > 8 || codes.some((code) => !/^[A-Z0-9]{4}$/.test(code))) {
    throw new TypeError("Invalid route airports");
  }
  if (!Array.isArray(value._airports) || value._airports.length !== codes.length) {
    throw new TypeError("Incomplete route airports");
  }
  const airports = value._airports.map((airport, index) => {
    if (!airport || airport.icao !== codes[index]) throw new TypeError("Airport order mismatch");
    return {
      icao: codes[index],
      iata: typeof airport.iata === "string" && /^[A-Z]{3}$/.test(airport.iata) ? airport.iata : null,
      name: shortText(airport.name),
      city: shortText(airport.location, 80)
    };
  });
  const route = {
    callsign,
    airline_code: typeof value.airline_code === "string" && /^[A-Z]{3}$/.test(value.airline_code)
      ? value.airline_code : null,
    airports,
    source: "VRS standing-data / ADSB.lol",
    source_url: ROUTE_SOURCE,
    fetched_at: iso(Date.parse(fetchedAt)),
    kind: "callsign_database"
  };
  if (new TextEncoder().encode(JSON.stringify(route)).length > 4096) throw new TypeError("Route is too large");
  return route;
}

export function decodeStoredRoute(value) {
  try {
    const route = JSON.parse(value);
    return route?.kind === "callsign_database" && Array.isArray(route.airports) ? route : null;
  } catch {
    return null;
  }
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > ROUTE_LIMITS.responseBytes) {
    await response.body?.cancel();
    throw new Error("Route response too large");
  }
  if (!response.body) throw new Error("Missing route response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ROUTE_LIMITS.responseBytes) throw new Error("Route response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function fetchSourceRoute(callsign, now, fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_LIMITS.timeoutMs);
  try {
    const response = await fetcher(routeSourceUrl(callsign), {
      signal: controller.signal,
      redirect: "error",
      headers: { Accept: "application/json" }
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return { state: "missing", route: null, retryAt: now + ROUTE_LIMITS.missingTtlMs, pauseUntil: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      const pause = response.status === 429 ? ROUTE_LIMITS.missingTtlMs : 5 * 60 * 1000;
      return { state: "error", route: null, retryAt: now + pause, pauseUntil: iso(now + pause) };
    }
    const route = parseSourceRoute(await readBoundedJson(response), callsign, iso(now));
    return { state: "found", route, retryAt: now + ROUTE_LIMITS.foundTtlMs, pauseUntil: null };
  } catch {
    return {
      state: "error", route: null,
      retryAt: now + ROUTE_LIMITS.errorTtlMs,
      pauseUntil: iso(now + 5 * 60 * 1000)
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function cacheRows(db, callsigns) {
  if (!callsigns.length) return new Map();
  const result = await db.prepare(`
    SELECT callsign, state, route_json, checked_at, retry_after
    FROM route_cache WHERE callsign IN (SELECT value FROM json_each(?))
  `).bind(JSON.stringify(callsigns)).all();
  return new Map((result.results || []).map((row) => [row.callsign, row]));
}

export async function addLiveRoutes(db, aircraft, capturedAt, now = Date.now()) {
  const observed = Date.parse(capturedAt);
  // Never decorate an old/offline snapshot with a new flight using the same callsign.
  if (!Number.isFinite(observed) || observed < now - 10 * 60 * 1000 || observed > now + 60_000) {
    return aircraft;
  }
  const callsigns = [...new Set(aircraft.map((item) => normalizeCallsign(item.callsign)).filter(Boolean))];
  const rows = await cacheRows(db, callsigns);
  return aircraft.map((item) => {
    const row = rows.get(normalizeCallsign(item.callsign));
    const route = row?.state === "found" && Date.parse(row.retry_after) > now
      ? decodeStoredRoute(row.route_json) : null;
    return { ...item, route };
  });
}

async function attachSnapshots(db, passes, now) {
  if (!passes.length) return;
  // Cached positive results are copied once, preserving historical callsign routes.
  await db.prepare(`
    INSERT INTO pass_routes (pass_id, callsign, route_json)
    SELECT p.id, c.callsign, c.route_json
    FROM passes p JOIN route_cache c ON c.callsign = UPPER(TRIM(p.callsign))
    LEFT JOIN pass_routes r ON r.pass_id = p.id
    WHERE p.id IN (SELECT value FROM json_each(?))
      AND p.last_seen >= ? AND p.first_seen <= ?
      AND c.state = 'found' AND c.retry_after > ?
      AND (r.pass_id IS NULL OR r.callsign IS NOT c.callsign)
    LIMIT ?
    ON CONFLICT(pass_id) DO UPDATE SET
      callsign = excluded.callsign, route_json = excluded.route_json
    WHERE pass_routes.callsign IS NOT excluded.callsign
  `).bind(JSON.stringify(passes.map((pass) => pass.id)), iso(now - ROUTE_LIMITS.recentWindowMs),
    iso(now), iso(now), ROUTE_LIMITS.snapshotBatch).run();
}

export async function enrichRecentRoutes(env, { now = Date.now(), fetcher = fetch } = {}) {
  if (!routesEnabled(env)) return;
  const db = env.DB;
  const timestamp = iso(now);
  const budget = await db.prepare("SELECT * FROM route_budget WHERE id = 1").first();
  if (!budget || (budget.lease_until && budget.lease_until >= timestamp)) return;

  const receiver = await db.prepare("SELECT captured_at, aircraft_json FROM receiver_state WHERE id = 1").first();
  const live = receiver && Date.parse(receiver.captured_at) >= now - 10 * 60 * 1000
    && Date.parse(receiver.captured_at) <= now + 60_000
    ? JSON.parse(receiver.aircraft_json) : [];
  const result = await db.prepare(`
    SELECT p.id, p.callsign, r.callsign AS saved_callsign
    FROM passes p LEFT JOIN pass_routes r ON r.pass_id = p.id
    WHERE p.last_seen >= ? AND p.first_seen <= ?
    ORDER BY p.last_seen DESC LIMIT ?
  `).bind(iso(now - ROUTE_LIMITS.recentWindowMs), timestamp, ROUTE_LIMITS.recentPasses).all();
  const passes = result.results || [];
  const candidates = [...new Set([
    ...live.map((item) => normalizeCallsign(item.callsign)),
    ...passes.filter((pass) => normalizeCallsign(pass.callsign) !== pass.saved_callsign)
      .map((pass) => normalizeCallsign(pass.callsign))
  ].filter(Boolean))];
  if (!candidates.length) return;
  await attachSnapshots(db, passes, now);
  const cached = await cacheRows(db, candidates);
  const callsign = candidates.find((candidate) => !cached.has(candidate)
    || Date.parse(cached.get(candidate).retry_after) <= now);
  if (!callsign || (budget.paused_until && budget.paused_until > timestamp)
    || (budget.day === timestamp.slice(0, 10) && budget.requests >= ROUTE_LIMITS.requestsPerUtcDay)) return;

  const lease = crypto.randomUUID();
  // RETURNING + conditional UPDATE is atomic even when scheduled executions overlap.
  const claimed = await db.prepare(`
    UPDATE route_budget SET day = ?,
      requests = CASE WHEN day = ? THEN requests + 1 ELSE 1 END,
      lease_id = ?, lease_until = ?
    WHERE id = 1 AND (lease_until IS NULL OR lease_until < ?)
      AND (paused_until IS NULL OR paused_until <= ?)
      AND (day <> ? OR requests < ?)
    RETURNING requests
  `).bind(timestamp.slice(0, 10), timestamp.slice(0, 10), lease, iso(now + 30_000),
    timestamp, timestamp, timestamp.slice(0, 10), ROUTE_LIMITS.requestsPerUtcDay).first();
  if (!claimed) return;

  let pauseUntil = null;
  try {
    // Only disposable cache entries older than seven days are removed, never passes.
    await db.prepare(`
      DELETE FROM route_cache WHERE callsign IN (
        SELECT callsign FROM route_cache WHERE retry_after < ? ORDER BY retry_after LIMIT 100
      )
    `).bind(iso(now - 7 * 24 * 60 * 60 * 1000)).run();
    if (!cached.has(callsign)) {
      const count = await db.prepare("SELECT COUNT(*) AS count FROM route_cache").first();
      if (count.count >= ROUTE_LIMITS.cacheEntries) return;
    }
    const outcome = await fetchSourceRoute(callsign, now, fetcher);
    pauseUntil = outcome.pauseUntil;
    await db.prepare(`
      INSERT INTO route_cache (callsign, state, route_json, checked_at, retry_after)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM route_budget WHERE id = 1 AND lease_id = ?
      ) AND ((SELECT COUNT(*) FROM route_cache) < ?
        OR EXISTS (SELECT 1 FROM route_cache WHERE callsign = ?))
      ON CONFLICT(callsign) DO UPDATE SET
        state = excluded.state, route_json = excluded.route_json,
        checked_at = excluded.checked_at, retry_after = excluded.retry_after
    `).bind(callsign, outcome.state, outcome.route ? JSON.stringify(outcome.route) : null,
      timestamp, iso(outcome.retryAt), lease, ROUTE_LIMITS.cacheEntries, callsign).run();
    if (outcome.state === "found") await attachSnapshots(db, passes, now);
  } finally {
    await db.prepare(`
      UPDATE route_budget SET lease_id = NULL, lease_until = NULL, paused_until = ?
      WHERE id = 1 AND lease_id = ?
    `).bind(pauseUntil, lease).run();
  }
}
