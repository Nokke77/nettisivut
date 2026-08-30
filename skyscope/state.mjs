export const DEFAULT_ONLINE_AFTER_MS = 90_000;
export const DEFAULT_OFFLINE_AFTER_MS = 300_000;

export function formatDateTime(value, locale = "fi-FI") {
  if (value === null || value === undefined || value === "") return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(date);
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

export const receiverStateLabels = Object.freeze({
  online: "Online",
  stale: "Vanhentunut",
  offline: "Offline",
  disconnected: "Ei yhdistetty"
});
