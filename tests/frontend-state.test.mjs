import test from "node:test";
import assert from "node:assert/strict";
import {
  aircraftOwnerLine,
  aircraftTypeLabel,
  deriveReceiverState,
  feetToMetres,
  formatDateTime,
  hasValidPosition,
  knotsToKmh
} from "../skyscope/state.mjs";

const now = Date.parse("2026-08-30T10:10:00Z");

test("receiver is online when the latest Worker receipt is fresh", () => {
  assert.equal(deriveReceiverState({ lastReceivedAt: "2026-08-30T10:09:30Z", now }), "online");
});

test("receiver is stale after the online window", () => {
  assert.equal(deriveReceiverState({ lastReceivedAt: "2026-08-30T10:08:00Z", now }), "stale");
});

test("receiver is marked stale during a short API failure", () => {
  assert.equal(deriveReceiverState({
    lastReceivedAt: "2026-08-30T10:09:30Z", now, requestFailed: true
  }), "stale");
});

test("receiver is offline after the offline window", () => {
  assert.equal(deriveReceiverState({ lastReceivedAt: "2026-08-30T10:04:00Z", now }), "offline");
});

test("missing coordinates are not interpreted as a zero-zero position", () => {
  assert.equal(hasValidPosition({ latitude: null, longitude: null }), false);
  assert.equal(hasValidPosition({ latitude: 0, longitude: 0 }), true);
});

test("missing closest timestamp is not formatted as the Unix epoch", () => {
  assert.equal(formatDateTime(null), "–");
  assert.equal(formatDateTime(undefined), "–");
  assert.equal(formatDateTime(""), "–");
});

test("aviation units are converted to metric display values", () => {
  assert.equal(feetToMetres(12000), 3657.6000000000004);
  assert.equal(knotsToKmh(310), 574.12);
  assert.equal(feetToMetres(null), null);
  assert.equal(knotsToKmh(""), null);
});

test("aircraft metadata becomes a human-readable identity", () => {
  const aircraft = {
    type_code: "at75",
    type_description: "ATR 72-500",
    owner_operator: "Finnair Oyj",
    registration: "oh-ati"
  };
  assert.equal(aircraftTypeLabel(aircraft), "ATR 72-500 (AT75)");
  assert.equal(aircraftOwnerLine(aircraft), "Finnair Oyj · OH-ATI");
});

test("aircraft identity helpers omit missing metadata cleanly", () => {
  assert.equal(aircraftTypeLabel({ type_code: "B738" }), "B738");
  assert.equal(aircraftOwnerLine({}), null);
});
