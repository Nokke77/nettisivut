export const DEFAULT_ONLINE_AFTER_MS = 90_000;
export const DEFAULT_OFFLINE_AFTER_MS = 300_000;
export const DISPLAY_TIME_ZONE = "Europe/Helsinki";

const trustedCallsignOperators = Object.freeze({
  FIN: "Finnair",
  NOZ: "Norwegian",
  CHH: "Hainan Airlines"
});

const airportCityLabels = Object.freeze({
  EFKU: "Kuopio", EFHK: "Helsinki", EGPH: "Edinburgh", ZBAA: "Peking"
});

export function formatDateTime(value, locale = "fi-FI", timeZone = DISPLAY_TIME_ZONE) {
  if (value === null || value === undefined || value === "") return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone
  }).format(date);
}

export function formatPassTimeRange(firstSeen, lastSeen, locale = "fi-FI") {
  const first = new Date(firstSeen);
  const last = new Date(lastSeen);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return "–";
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: DISPLAY_TIME_ZONE
  });
  return `${formatter.format(first).replace(":", ".")}–${formatter.format(last).replace(":", ".")}`;
}

export function helsinkiDate(value = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: DISPLAY_TIME_ZONE
    }).formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function deriveReceiverState({
  lastReceivedAt,
  requestFailed = false,
  now = Date.now(),
  onlineAfterMs = DEFAULT_ONLINE_AFTER_MS,
  offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS
}) {
  const timestamp = Date.parse(lastReceivedAt || "");

  if (!Number.isFinite(timestamp)) {
    return "offline";
  }

  const age = Math.max(0, now - timestamp);

  if (age > offlineAfterMs) {
    return "offline";
  }

  if (requestFailed || age > onlineAfterMs) {
    return "stale";
  }

  return "online";
}

export function hasValidPosition(aircraft) {
  const latitude = aircraft?.latitude;
  const longitude = aircraft?.longitude;
  if (latitude === null || latitude === undefined || latitude === "") return false;
  if (longitude === null || longitude === undefined || longitude === "") return false;
  const numericLatitude = Number(latitude);
  const numericLongitude = Number(longitude);
  return (
    Number.isFinite(numericLatitude)
    && Number.isFinite(numericLongitude)
    && numericLatitude >= -90
    && numericLatitude <= 90
    && numericLongitude >= -180
    && numericLongitude <= 180
  );
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function feetToMetres(value) {
  const feet = finiteNumber(value);
  return feet === null ? null : feet * 0.3048;
}

export function knotsToKmh(value) {
  const knots = finiteNumber(value);
  return knots === null ? null : knots * 1.852;
}

export function aircraftTypeLabel(aircraft) {
  const description = typeof aircraft?.type_description === "string"
    ? aircraft.type_description.trim()
    : "";
  const code = typeof aircraft?.type_code === "string"
    ? aircraft.type_code.trim().toUpperCase()
    : "";

  if (description && code && description.toUpperCase() !== code) {
    return `${description} (${code})`;
  }
  return description || code || null;
}

export function aircraftOwnerLine(aircraft) {
  const ownerOperator = typeof aircraft?.owner_operator === "string"
    ? aircraft.owner_operator.trim()
    : "";
  const registration = typeof aircraft?.registration === "string"
    ? aircraft.registration.trim().toUpperCase()
    : "";
  return [ownerOperator, registration].filter(Boolean).join(" · ") || null;
}

function friendlyOwnerName(value) {
  const owner = typeof value === "string" ? value.trim() : "";
  if (!owner) return null;
  if (/^finnair\b/i.test(owner)) return "Finnair";
  if (/^norwegian\b/i.test(owner)) return "Norwegian";
  return owner;
}

export function aircraftOperatorLabel(aircraft) {
  if (aircraft?.is_military === true) return "Sotilaskone";
  const owner = friendlyOwnerName(aircraft?.owner_operator);
  if (owner) return owner;
  const callsign = typeof aircraft?.callsign === "string"
    ? aircraft.callsign.trim().toUpperCase()
    : "";
  const prefix = /^([A-Z]{3})/.exec(callsign)?.[1];
  return trustedCallsignOperators[prefix] || "Tuntematon operaattori";
}

export function passRouteLabel(pass) {
  const airports = pass?.route?.airports;
  if (pass?.route?.kind === "callsign_database" && Array.isArray(airports)
    && airports.length >= 2 && airports.length <= 8) {
    const labels = airports.map((airport) => airportCityLabels[airport?.icao]
      || airport?.city || airport?.iata || airport?.icao);
    if (labels.every((label) => typeof label === "string" && label.trim())) {
      // Preserve all stops: a multi-leg route is not a verified single flight leg.
      return labels.join(" → ");
    }
  }
  const origin = typeof pass?.origin_iata === "string"
    ? pass.origin_iata.trim().toUpperCase()
    : "";
  const destination = typeof pass?.destination_iata === "string"
    ? pass.destination_iata.trim().toUpperCase()
    : "";
  return /^[A-Z]{3}$/.test(origin) && /^[A-Z]{3}$/.test(destination)
    ? `${origin} → ${destination}`
    : "Reitti ei tiedossa";
}

export function passTypeLabel(pass) {
  const description = typeof pass?.type_description === "string"
    ? pass.type_description.trim()
    : "";
  const code = typeof pass?.type_code === "string"
    ? pass.type_code.trim().toUpperCase()
    : "";
  return description || code || "Konetyyppi ei tiedossa";
}

export const receiverStateLabels = Object.freeze({
  online: "Online",
  stale: "Vanhentunut",
  offline: "Offline",
  disconnected: "Ei yhdistetty"
});
