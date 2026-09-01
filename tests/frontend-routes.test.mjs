import test from "node:test";
import assert from "node:assert/strict";
import { aircraftOperatorLabel, passRouteLabel, routeProvenanceLabel } from "../skyscope/state.mjs";

const route = {
  kind: "callsign_database", fetched_at: "2026-09-01T14:00:00Z",
  airports: [
    { icao: "EFKU", iata: "KUO", city: "Kuopio / Siilinjärvi" },
    { icao: "EFHK", iata: "HEL", city: "Helsinki" }
  ]
};

test("day list and live cards show readable cities instead of only airport codes", () => {
  assert.equal(passRouteLabel({ route }), "Kuopio → Helsinki");
  assert.equal(aircraftOperatorLabel({ callsign: "CHH408" }), "Hainan Airlines");
  assert.equal(aircraftOperatorLabel({ callsign: "FIN6YP", is_military: true }), "Sotilaskone");
});

test("city labels preserve order and intermediate stops", () => {
  const value = structuredClone(route);
  value.airports.push({ icao: "EGPH", iata: "EDI", city: "Edinburgh" });
  assert.equal(passRouteLabel({ route: value }), "Kuopio → Helsinki → Edinburgh");
  value.airports.reverse();
  assert.equal(passRouteLabel({ route: value }), "Edinburgh → Helsinki → Kuopio");
});

test("unknown cities fall back to codes without inferring a destination", () => {
  const value = { ...route, airports: [{ icao: "ABCD", iata: "ABC" }, { icao: "EFGH" }] };
  assert.equal(passRouteLabel({ route: value }), "ABC → EFGH");
  assert.equal(passRouteLabel({}), "Reitti ei tiedossa");
  assert.equal(passRouteLabel({ route: { kind: "callsign_database", airports: [] } }), "Reitti ei tiedossa");
});

test("route provenance says source lookup time, not a verified flight plan", () => {
  const label = routeProvenanceLabel({ route });
  assert.match(label, /Tietokannan reitti/);
  assert.match(label, /haettu/);
  assert.match(label, /ei ole vahvistettu/);
  assert.equal(routeProvenanceLabel({}), null);
});
