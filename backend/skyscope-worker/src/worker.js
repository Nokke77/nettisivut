const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_AIRCRAFT = 250;
const MAX_PASSES_PER_INGEST = 100;

function numberSetting(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = [env.PRODUCTION_ORIGIN, env.LOCAL_DEV_ORIGIN].filter(Boolean);
  return allowed.includes(origin) ? origin : false;
}

function jsonResponse(body, status = 200, origin = null, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": status >= 400 ? "no-store" : "public, max-age=15",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function isAuthorized(request, env) {
  if (!env.INGEST_TOKEN) return false;
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return Boolean(match && timingSafeEqual(match[1], env.INGEST_TOKEN));
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requiredString(value, label, maxLength = 128) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, label, maxLength = 128) {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, label, maxLength);
}

function boundedNumber(value, label, minimum, maximum, nullable = true) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${label} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside the allowed range`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function isoTimestamp(value, label) {
  const source = requiredString(value, label, 64);
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function icao(value, label = "icao") {
  const normalized = requiredString(value, label, 16).toUpperCase();
  if (!/^~?[A-Z0-9]{2,15}$/.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function validateAircraft(value, index) {
  const item = requiredObject(value, `aircraft[${index}]`);
  return {
    icao: icao(item.icao, `aircraft[${index}].icao`),
    callsign: optionalString(item.callsign, `aircraft[${index}].callsign`, 16),
    latitude: boundedNumber(item.latitude, `aircraft[${index}].latitude`, -90, 90),
    longitude: boundedNumber(item.longitude, `aircraft[${index}].longitude`, -180, 180),
    altitude_ft: boundedNumber(item.altitude_ft, `aircraft[${index}].altitude_ft`, -2000, 100000),
    speed_knots: boundedNumber(item.speed_knots, `aircraft[${index}].speed_knots`, 0, 2000),
    track_deg: boundedNumber(item.track_deg, `aircraft[${index}].track_deg`, 0, 360),
    signal_db: boundedNumber(item.signal_db, `aircraft[${index}].signal_db`, -200, 100),
    distance_km: boundedNumber(item.distance_km, `aircraft[${index}].distance_km`, 0, 20000),
    messages: item.messages === null || item.messages === undefined
      ? null
      : nonNegativeInteger(item.messages, `aircraft[${index}].messages`),
    seen_at: isoTimestamp(item.seen_at, `aircraft[${index}].seen_at`)
  };
}

function validatePass(value, index) {
  const item = requiredObject(value, `passes[${index}]`);
  const id = requiredString(item.id, `passes[${index}].id`, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError(`passes[${index}].id is invalid`);
  return {
    id,
    icao: icao(item.icao, `passes[${index}].icao`),
    callsign: optionalString(item.callsign, `passes[${index}].callsign`, 16),
    first_seen: isoTimestamp(item.first_seen, `passes[${index}].first_seen`),
    last_seen: isoTimestamp(item.last_seen, `passes[${index}].last_seen`),
    closest_distance_km: boundedNumber(item.closest_distance_km, `passes[${index}].closest_distance_km`, 0, 20000),
    closest_at: item.closest_at ? isoTimestamp(item.closest_at, `passes[${index}].closest_at`) : null
  };
}

function validateStats(value) {
  const stats = requiredObject(value, "stats");
  const date = requiredString(stats.date, "stats.date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("stats.date is invalid");

  let closestAircraft = null;
  if (stats.closest_aircraft !== null && stats.closest_aircraft !== undefined) {
    const closest = requiredObject(stats.closest_aircraft, "stats.closest_aircraft");
    closestAircraft = {
      icao: icao(closest.icao, "stats.closest_aircraft.icao"),
      callsign: optionalString(closest.callsign, "stats.closest_aircraft.callsign", 16),
      distance_km: boundedNumber(closest.distance_km, "stats.closest_aircraft.distance_km", 0, 20000, false),
      at: isoTimestamp(closest.at, "stats.closest_aircraft.at")
    };
  }

  return {
    date,
    unique_aircraft_count: nonNegativeInteger(stats.unique_aircraft_count, "stats.unique_aircraft_count"),
    pass_count: nonNegativeInteger(stats.pass_count, "stats.pass_count"),
    closest_aircraft: closestAircraft
  };
}

function validatePayload(value) {
  const payload = requiredObject(value, "payload");
  if (payload.schema_version !== 1) throw new TypeError("schema_version must be 1");
  if (!Array.isArray(payload.aircraft) || payload.aircraft.length > MAX_AIRCRAFT) {
    throw new TypeError(`aircraft must contain at most ${MAX_AIRCRAFT} items`);
  }
  if (!Array.isArray(payload.passes) || payload.passes.length > MAX_PASSES_PER_INGEST) {
    throw new TypeError(`passes must contain at most ${MAX_PASSES_PER_INGEST} items`);
  }
  return {
    schema_version: 1,
    captured_at: isoTimestamp(payload.captured_at, "captured_at"),
    aircraft: payload.aircraft.map(validateAircraft),
    passes: payload.passes.map(validatePass),
    stats: validateStats(payload.stats)
  };
}

async function handleIngest(request, env, origin) {
  if (!env.INGEST_TOKEN) {
    return jsonResponse({ error: "Ingest is not configured" }, 503, origin);
  }
  if (!isAuthorized(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin, { "WWW-Authenticate": "Bearer" });
  }
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json" }, 415, origin);
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Request body is too large" }, 413, origin);
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return jsonResponse({ error: "Could not read request body" }, 400, origin);
  }
  if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Request body is too large" }, 413, origin);
  }

  let payload;
  try {
    payload = validatePayload(JSON.parse(text));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "Malformed JSON" : "Invalid payload";
    return jsonResponse({ error: reason }, 400, origin);
  }

  const receivedAt = new Date().toISOString();
  const statements = [
    env.DB.prepare(`
      INSERT INTO receiver_state (id, captured_at, received_at, aircraft_json)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        captured_at = excluded.captured_at,
        received_at = excluded.received_at,
        aircraft_json = excluded.aircraft_json
      WHERE excluded.captured_at >= receiver_state.captured_at
    `).bind(payload.captured_at, receivedAt, JSON.stringify(payload.aircraft)),
    ...payload.passes.map((pass) => env.DB.prepare(`
      INSERT INTO passes (
        id, icao, callsign, first_seen, last_seen,
        closest_distance_km, closest_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        callsign = COALESCE(excluded.callsign, passes.callsign),
        first_seen = MIN(passes.first_seen, excluded.first_seen),
        last_seen = MAX(passes.last_seen, excluded.last_seen),
        closest_distance_km = CASE
          WHEN excluded.closest_distance_km IS NULL THEN passes.closest_distance_km
          WHEN passes.closest_distance_km IS NULL OR excluded.closest_distance_km < passes.closest_distance_km
            THEN excluded.closest_distance_km
          ELSE passes.closest_distance_km
        END,
        closest_at = CASE
          WHEN excluded.closest_distance_km IS NULL THEN passes.closest_at
          WHEN passes.closest_distance_km IS NULL OR excluded.closest_distance_km < passes.closest_distance_km
            THEN excluded.closest_at
          ELSE passes.closest_at
        END,
        updated_at = excluded.updated_at
    `).bind(
      pass.id,
      pass.icao,
      pass.callsign,
      pass.first_seen,
      pass.last_seen,
      pass.closest_distance_km,
      pass.closest_at,
      receivedAt
    )),
    env.DB.prepare(`
      INSERT INTO daily_stats (
        date, unique_aircraft_count, pass_count, closest_icao,
        closest_callsign, closest_distance_km, closest_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        unique_aircraft_count = excluded.unique_aircraft_count,
        pass_count = excluded.pass_count,
        closest_icao = excluded.closest_icao,
        closest_callsign = excluded.closest_callsign,
        closest_distance_km = excluded.closest_distance_km,
        closest_at = excluded.closest_at,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= daily_stats.updated_at
    `).bind(
      payload.stats.date,
      payload.stats.unique_aircraft_count,
      payload.stats.pass_count,
      payload.stats.closest_aircraft?.icao || null,
      payload.stats.closest_aircraft?.callsign || null,
      payload.stats.closest_aircraft?.distance_km ?? null,
      payload.stats.closest_aircraft?.at || null,
      payload.captured_at
    )
  ];

  await env.DB.batch(statements);
  return jsonResponse({ ok: true, received_at: receivedAt }, 202, origin, { "Cache-Control": "no-store" });
}

async function getStatus(env, origin) {
  const row = await env.DB.prepare(
    "SELECT captured_at, received_at FROM receiver_state WHERE id = 1"
  ).first();
  if (!row) return jsonResponse({ state: "offline", last_update: null, received_at: null }, 200, origin);

  const onlineAfter = numberSetting(env.ONLINE_AFTER_SECONDS, 90, 15, 3600) * 1000;
  const offlineAfter = Math.max(
    onlineAfter,
    numberSetting(env.OFFLINE_AFTER_SECONDS, 300, 30, 86400) * 1000
  );
  const age = Math.max(0, Date.now() - Date.parse(row.received_at));
  const state = age <= onlineAfter ? "online" : age <= offlineAfter ? "stale" : "offline";
  return jsonResponse({ state, last_update: row.captured_at, received_at: row.received_at }, 200, origin);
}

async function getLive(env, origin) {
  const row = await env.DB.prepare(
    "SELECT captured_at, aircraft_json FROM receiver_state WHERE id = 1"
  ).first();
  return jsonResponse({
    updated_at: row?.captured_at || null,
    aircraft: row ? JSON.parse(row.aircraft_json) : []
  }, 200, origin);
}

async function getPasses(request, env, origin) {
  const configuredMaximum = numberSetting(env.MAX_PUBLIC_PASSES, 50, 1, 100);
  const requested = numberSetting(new URL(request.url).searchParams.get("limit"), configuredMaximum, 1, configuredMaximum);
  const result = await env.DB.prepare(`
    SELECT id, icao, callsign, first_seen, last_seen, closest_distance_km, closest_at
    FROM passes
    ORDER BY last_seen DESC
    LIMIT ?
  `).bind(requested).all();
  return jsonResponse({ passes: result.results || [] }, 200, origin);
}

async function getStats(request, env, origin) {
  const requestedDate = new URL(request.url).searchParams.get("date");
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return jsonResponse({ error: "Invalid date" }, 400, origin);
  }
  const row = requestedDate
    ? await env.DB.prepare("SELECT * FROM daily_stats WHERE date = ?").bind(requestedDate).first()
    : await env.DB.prepare("SELECT * FROM daily_stats ORDER BY date DESC LIMIT 1").first();

  if (!row) {
    return jsonResponse({
      date: requestedDate,
      unique_aircraft_count: 0,
      pass_count: 0,
      closest_aircraft: null
    }, 200, origin);
  }
  return jsonResponse({
    date: row.date,
    unique_aircraft_count: row.unique_aircraft_count,
    pass_count: row.pass_count,
    closest_aircraft: row.closest_icao ? {
      icao: row.closest_icao,
      callsign: row.closest_callsign,
      distance_km: row.closest_distance_km,
      at: row.closest_at
    } : null
  }, 200, origin);
}

async function route(request, env) {
  const origin = allowedOrigin(request, env);
  if (origin === false) return jsonResponse({ error: "Origin is not allowed" }, 403);

  if (request.method === "OPTIONS") {
    if (!origin) return jsonResponse({ error: "Origin is required" }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin"
      }
    });
  }

  const { pathname } = new URL(request.url);
  if (pathname === "/api/ingest" && request.method === "POST") return handleIngest(request, env, origin);
  if (pathname === "/api/status" && request.method === "GET") return getStatus(env, origin);
  if (pathname === "/api/live" && request.method === "GET") return getLive(env, origin);
  if (pathname === "/api/passes" && request.method === "GET") return getPasses(request, env, origin);
  if (pathname === "/api/stats" && request.method === "GET") return getStats(request, env, origin);
  return jsonResponse({ error: "Not found" }, 404, origin);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("SkyScope Worker error", error);
      return jsonResponse({ error: "Internal server error" }, 500, allowedOrigin(request, env) || null);
    }
  }
};

export { validatePayload };
