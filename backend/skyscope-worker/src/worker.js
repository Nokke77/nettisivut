import { addLiveRoutes, decodeStoredRoute, enrichRecentRoutes, routesEnabled } from "./routes.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_AIRCRAFT = 250;
const MAX_PASSES_PER_INGEST = 100;
const MAX_PUBLIC_PASS_PAGE_SIZE = 100;
const PUBLIC_TIME_ZONE = "Europe/Helsinki";

const helsinkiDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PUBLIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function numberSetting(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === "") return fallback;
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

function optionalBoolean(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
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

function validCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dateTimePartsAt(instant) {
  return Object.fromEntries(
    helsinkiDateTimeFormatter.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function helsinkiOffsetMilliseconds(epochMilliseconds) {
  const instant = new Date(epochMilliseconds);
  const parts = dateTimePartsAt(instant);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return representedAsUtc - Math.trunc(epochMilliseconds / 1000) * 1000;
}

function helsinkiMidnightUtc(dateString) {
  if (!validCalendarDate(dateString)) throw new TypeError("Invalid date");
  const [year, month, day] = dateString.split("-").map(Number);
  const localWallTime = Date.UTC(year, month - 1, day);
  let epochMilliseconds = localWallTime;
  for (let index = 0; index < 3; index += 1) {
    epochMilliseconds = localWallTime - helsinkiOffsetMilliseconds(epochMilliseconds);
  }
  const parts = dateTimePartsAt(new Date(epochMilliseconds));
  if (
    parts.year !== year
    || parts.month !== month
    || parts.day !== day
    || parts.hour !== 0
    || parts.minute !== 0
    || parts.second !== 0
  ) {
    throw new TypeError("Invalid date");
  }
  return new Date(epochMilliseconds).toISOString();
}

function nextCalendarDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [
    String(next.getUTCFullYear()).padStart(4, "0"),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function helsinkiDateRange(dateString) {
  return {
    start: helsinkiMidnightUtc(dateString),
    end: helsinkiMidnightUtc(nextCalendarDate(dateString))
  };
}

function encodePassCursor(pass) {
  return btoa(JSON.stringify([pass.first_seen, pass.id]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodePassCursor(value) {
  if (typeof value !== "string" || !value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Invalid cursor");
  }
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = JSON.parse(atob(base64 + padding));
    if (!Array.isArray(decoded) || decoded.length !== 2) throw new TypeError("Invalid cursor");
    const firstSeen = isoTimestamp(decoded[0], "cursor timestamp");
    const id = requiredString(decoded[1], "cursor id", 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError("Invalid cursor");
    return { firstSeen, id };
  } catch {
    throw new TypeError("Invalid cursor");
  }
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
    registration: optionalString(item.registration, `aircraft[${index}].registration`, 32),
    type_code: optionalString(item.type_code, `aircraft[${index}].type_code`, 16),
    type_description: optionalString(
      item.type_description,
      `aircraft[${index}].type_description`,
      128
    ),
    owner_operator: optionalString(
      item.owner_operator,
      `aircraft[${index}].owner_operator`,
      160
    ),
    is_military: optionalBoolean(item.is_military, `aircraft[${index}].is_military`),
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
  const pass = {
    id,
    icao: icao(item.icao, `passes[${index}].icao`),
    callsign: optionalString(item.callsign, `passes[${index}].callsign`, 16),
    first_seen: isoTimestamp(item.first_seen, `passes[${index}].first_seen`),
    last_seen: isoTimestamp(item.last_seen, `passes[${index}].last_seen`),
    closest_distance_km: boundedNumber(item.closest_distance_km, `passes[${index}].closest_distance_km`, 0, 20000),
    closest_at: item.closest_at ? isoTimestamp(item.closest_at, `passes[${index}].closest_at`) : null,
    min_altitude_ft: boundedNumber(item.min_altitude_ft, `passes[${index}].min_altitude_ft`, -2000, 100000),
    max_altitude_ft: boundedNumber(item.max_altitude_ft, `passes[${index}].max_altitude_ft`, -2000, 100000)
  };
  if (
    pass.min_altitude_ft !== null
    && pass.max_altitude_ft !== null
    && pass.min_altitude_ft > pass.max_altitude_ft
  ) {
    throw new TypeError(`passes[${index}] altitude range is invalid`);
  }
  return pass;
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
  const aircraftWithMetadata = payload.aircraft.filter((aircraft) => (
    aircraft.registration !== null
    || aircraft.type_code !== null
    || aircraft.type_description !== null
    || aircraft.owner_operator !== null
    || aircraft.is_military !== null
  ));
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
    ...aircraftWithMetadata.map((aircraft) => env.DB.prepare(`
      INSERT INTO aircraft_metadata (
        icao, registration, type_code, type_description,
        owner_operator, is_military, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(icao) DO UPDATE SET
        registration = COALESCE(excluded.registration, aircraft_metadata.registration),
        type_code = COALESCE(excluded.type_code, aircraft_metadata.type_code),
        type_description = COALESCE(
          excluded.type_description,
          aircraft_metadata.type_description
        ),
        owner_operator = COALESCE(
          excluded.owner_operator,
          aircraft_metadata.owner_operator
        ),
        is_military = COALESCE(excluded.is_military, aircraft_metadata.is_military),
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= aircraft_metadata.updated_at
        AND (
          (
            excluded.registration IS NOT NULL
            AND excluded.registration IS NOT aircraft_metadata.registration
          )
          OR (
            excluded.type_code IS NOT NULL
            AND excluded.type_code IS NOT aircraft_metadata.type_code
          )
          OR (
            excluded.type_description IS NOT NULL
            AND excluded.type_description IS NOT aircraft_metadata.type_description
          )
          OR (
            excluded.owner_operator IS NOT NULL
            AND excluded.owner_operator IS NOT aircraft_metadata.owner_operator
          )
          OR (
            excluded.is_military IS NOT NULL
            AND excluded.is_military IS NOT aircraft_metadata.is_military
          )
        )
    `).bind(
      aircraft.icao,
      aircraft.registration,
      aircraft.type_code,
      aircraft.type_description,
      aircraft.owner_operator,
      aircraft.is_military === null ? null : Number(aircraft.is_military),
      payload.captured_at
    )),
    ...payload.passes.map((pass) => env.DB.prepare(`
      INSERT INTO passes (
        id, icao, callsign, first_seen, last_seen,
        closest_distance_km, closest_at, min_altitude_ft,
        max_altitude_ft, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        min_altitude_ft = CASE
          WHEN excluded.min_altitude_ft IS NULL THEN passes.min_altitude_ft
          WHEN passes.min_altitude_ft IS NULL OR excluded.min_altitude_ft < passes.min_altitude_ft
            THEN excluded.min_altitude_ft
          ELSE passes.min_altitude_ft
        END,
        max_altitude_ft = CASE
          WHEN excluded.max_altitude_ft IS NULL THEN passes.max_altitude_ft
          WHEN passes.max_altitude_ft IS NULL OR excluded.max_altitude_ft > passes.max_altitude_ft
            THEN excluded.max_altitude_ft
          ELSE passes.max_altitude_ft
        END,
        updated_at = excluded.updated_at
      WHERE excluded.first_seen < passes.first_seen
        OR excluded.last_seen > passes.last_seen
        OR (
          excluded.callsign IS NOT NULL
          AND excluded.callsign IS NOT passes.callsign
        )
        OR (
          excluded.closest_distance_km IS NOT NULL
          AND (
            passes.closest_distance_km IS NULL
            OR excluded.closest_distance_km < passes.closest_distance_km
          )
        )
        OR (
          excluded.min_altitude_ft IS NOT NULL
          AND (
            passes.min_altitude_ft IS NULL
            OR excluded.min_altitude_ft < passes.min_altitude_ft
          )
        )
        OR (
          excluded.max_altitude_ft IS NOT NULL
          AND (
            passes.max_altitude_ft IS NULL
            OR excluded.max_altitude_ft > passes.max_altitude_ft
          )
        )
    `).bind(
      pass.id,
      pass.icao,
      pass.callsign,
      pass.first_seen,
      pass.last_seen,
      pass.closest_distance_km,
      pass.closest_at,
      pass.min_altitude_ft,
      pass.max_altitude_ft,
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
        AND (
          excluded.unique_aircraft_count IS NOT daily_stats.unique_aircraft_count
          OR excluded.pass_count IS NOT daily_stats.pass_count
          OR excluded.closest_icao IS NOT daily_stats.closest_icao
          OR excluded.closest_callsign IS NOT daily_stats.closest_callsign
          OR excluded.closest_distance_km IS NOT daily_stats.closest_distance_km
          OR excluded.closest_at IS NOT daily_stats.closest_at
        )
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
  let aircraft = row ? JSON.parse(row.aircraft_json) : [];
  if (routesEnabled(env) && aircraft.length) {
    try {
      aircraft = await addLiveRoutes(env.DB, aircraft, row.captured_at);
    } catch {
      // A route failure must not hide aircraft or change receiver health.
      console.warn("SkyScope live route metadata unavailable");
    }
  }
  return jsonResponse({
    updated_at: row?.captured_at || null,
    aircraft
  }, 200, origin);
}

function publicPass(pass) {
  const { route_json: routeJson, ...fields } = pass;
  return {
    ...fields,
    route: decodeStoredRoute(routeJson),
    is_military: pass.is_military === null || pass.is_military === undefined
      ? null
      : Boolean(pass.is_military)
  };
}

async function getPasses(request, env, origin) {
  const searchParams = new URL(request.url).searchParams;
  const requestedDate = searchParams.get("date");
  const routeColumns = routesEnabled(env) ? ", r.route_json" : "";
  const routeJoin = routesEnabled(env)
    ? "LEFT JOIN pass_routes AS r ON r.pass_id = p.id AND r.callsign = UPPER(TRIM(p.callsign))"
    : "";

  if (requestedDate === null) {
    const configuredMaximum = numberSetting(env.MAX_PUBLIC_PASSES, 50, 1, 100);
    const requested = numberSetting(searchParams.get("limit"), configuredMaximum, 1, configuredMaximum);
    const result = await env.DB.prepare(`
      SELECT
        p.id, p.icao, p.callsign, p.first_seen, p.last_seen,
        p.closest_distance_km, p.closest_at,
        p.min_altitude_ft, p.max_altitude_ft,
        m.registration, m.type_code, m.type_description,
        m.owner_operator, m.is_military ${routeColumns}
      FROM passes AS p
      LEFT JOIN aircraft_metadata AS m ON m.icao = p.icao
      ${routeJoin}
      ORDER BY p.last_seen DESC
      LIMIT ?
    `).bind(requested).all();
    return jsonResponse({ passes: (result.results || []).map(publicPass) }, 200, origin);
  }

  if (!validCalendarDate(requestedDate)) {
    return jsonResponse({ error: "Invalid date" }, 400, origin);
  }

  let cursor = null;
  const encodedCursor = searchParams.get("cursor");
  if (encodedCursor !== null) {
    try {
      cursor = decodePassCursor(encodedCursor);
    } catch {
      return jsonResponse({ error: "Invalid cursor" }, 400, origin);
    }
  }

  const requested = numberSetting(
    searchParams.get("limit"),
    MAX_PUBLIC_PASS_PAGE_SIZE,
    1,
    MAX_PUBLIC_PASS_PAGE_SIZE
  );
  const { start, end } = helsinkiDateRange(requestedDate);
  const cursorPredicate = cursor
    ? "AND (p.first_seen < ? OR (p.first_seen = ? AND p.id < ?))"
    : "";
  const values = cursor
    ? [start, end, cursor.firstSeen, cursor.firstSeen, cursor.id, requested + 1]
    : [start, end, requested + 1];
  const result = await env.DB.prepare(`
    SELECT
      p.id, p.icao, p.callsign, p.first_seen, p.last_seen,
      p.closest_distance_km, p.closest_at,
      p.min_altitude_ft, p.max_altitude_ft,
      m.registration, m.type_code, m.type_description,
      m.owner_operator, m.is_military ${routeColumns}
    FROM passes AS p
    LEFT JOIN aircraft_metadata AS m ON m.icao = p.icao
    ${routeJoin}
    WHERE p.first_seen >= ? AND p.first_seen < ?
      ${cursorPredicate}
    ORDER BY p.first_seen DESC, p.id DESC
    LIMIT ?
  `).bind(...values).all();
  const rows = result.results || [];
  const page = rows.slice(0, requested);
  return jsonResponse({
    date: requestedDate,
    time_zone: PUBLIC_TIME_ZONE,
    passes: page.map(publicPass),
    next_cursor: rows.length > requested ? encodePassCursor(page[page.length - 1]) : null
  }, 200, origin);
}

async function getStats(request, env, origin) {
  const requestedDate = new URL(request.url).searchParams.get("date");
  if (requestedDate && !validCalendarDate(requestedDate)) {
    return jsonResponse({ error: "Invalid date" }, 400, origin);
  }
  const selection = `
    SELECT
      s.*,
      m.registration, m.type_code, m.type_description,
      m.owner_operator, m.is_military
    FROM daily_stats AS s
    LEFT JOIN aircraft_metadata AS m ON m.icao = s.closest_icao
  `;
  const row = requestedDate
    ? await env.DB.prepare(`${selection} WHERE s.date = ?`).bind(requestedDate).first()
    : await env.DB.prepare(`${selection} ORDER BY s.date DESC LIMIT 1`).first();

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
      registration: row.registration,
      type_code: row.type_code,
      type_description: row.type_description,
      owner_operator: row.owner_operator,
      is_military: row.is_military === null || row.is_military === undefined
        ? null
        : Boolean(row.is_military),
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
  if (pathname === "/api/passes" && request.method === "GET") {
    try {
      return await getPasses(request, env, origin);
    } catch (error) {
      if (!routesEnabled(env)) throw error;
      console.warn("SkyScope pass route metadata unavailable");
      return getPasses(request, { ...env, ROUTE_ENRICHMENT_ENABLED: "false" }, origin);
    }
  }
  if (pathname === "/api/stats" && request.method === "GET") return getStats(request, env, origin);
  return jsonResponse({ error: "Not found" }, 404, origin);
}

export default {
  async scheduled(_event, env) {
    try {
      await enrichRecentRoutes(env);
    } catch {
      // No raw upstream response, receiver coordinates or tokens in logs.
      console.warn("SkyScope route enrichment unavailable");
    }
  },
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("SkyScope Worker error", error);
      return jsonResponse({ error: "Internal server error" }, 500, allowedOrigin(request, env) || null);
    }
  }
};

export { helsinkiDateRange, validatePayload };
