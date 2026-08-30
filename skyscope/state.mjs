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

export const receiverStateLabels = Object.freeze({
  online: "Online",
  stale: "Vanhentunut",
  offline: "Offline",
  disconnected: "Ei yhdistetty"
});
