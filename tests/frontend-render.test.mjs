import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as stateHelpers from "../skyscope/state.mjs";

// Deliberately small DOM test double. Tests the production rendering code, not
// browser layout, accessibility behaviour or a substitute for visual QA.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.open = false;
    this.classList = { add: (name) => { this.className += ` ${name}`; } };
  }
  set textContent(value) { this.value = String(value ?? ""); this.children = []; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(" "); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.value = ""; this.children = children; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = (node) => selector === "details[open][data-pass-id]"
      ? node.tagName === "details" && node.open && Boolean(node.dataset.passId)
      : selector.startsWith(".")
        ? node.className.split(/\s+/).includes(selector.slice(1))
        : node.tagName === selector;
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
}

const source = (await readFile(new URL("../skyscope/skyscope.js", import.meta.url), "utf8"))
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\.\/state\.mjs[^\"]*";/, "");

function app(fetcher = async () => { throw new Error("Unexpected HTTP request"); }) {
  const elements = new Map();
  const context = vm.createContext({
    ...stateHelpers, URLSearchParams, console,
    fetch: fetcher,
    window: { SKYSCOPE_CONFIG: { apiBaseUrl: "" }, setInterval() {} },
    document: {
      createElement: (tag) => new Element(tag),
      querySelector: (selector) => {
        if (!elements.has(selector)) elements.set(selector, new Element("div"));
        return elements.get(selector);
      }
    }
  });
  vm.runInContext(source, context, { filename: "skyscope/skyscope.js" });
  return {
    element: (name) => elements.get(`[data-${name}]`),
    renderPasses: (passes) => context.renderPasses(passes),
    renderAircraft: (aircraft) => context.renderAircraft(aircraft),
    fetchAllPasses: (date) => context.fetchAllPasses(date)
  };
}

const now = "2026-09-01T14:00:00Z";
const route = {
  kind: "callsign_database", fetched_at: now,
  airports: [{ icao: "EFKU", iata: "KUO" }, { icao: "EFHK", iata: "HEL" }]
};
const pass = (id) => ({
  id: String(id), callsign: "FIN6YP", icao: "4601F6", route,
  first_seen: now, last_seen: now, closest_at: now,
  min_altitude_ft: 3000, max_altitude_ft: 4000, closest_distance_km: 3.4
});

test("ten observed passes render as ten compact readable rows, not one latest flight", () => {
  const page = app();
  page.renderPasses(Array.from({ length: 10 }, (_, index) => pass(index)));
  const list = page.element("passes-list");
  assert.equal(list.children.length, 10);
  assert.equal(page.element("passes-count").textContent, "10 ohitusta");
  for (const row of list.children) {
    assert.equal(row.tagName, "details");
    assert.equal(row.open, false);
    assert.match(row.querySelector("summary").textContent, /Finnair.*FIN6YP.*Kuopio → Helsinki/);
    assert.match(row.textContent, /ei ole vahvistettu/);
    assert.equal(row.querySelector("a").href, "https://github.com/vradarserver/standing-data");
    assert.match(row.textContent, /914–1\s?219 m/);
  }
});

test("a route detail opened by the reader stays open across the 30-second refresh", () => {
  const page = app();
  page.renderPasses([pass(1), pass(2)]);
  page.element("passes-list").children[1].open = true;
  page.renderPasses([pass(3), pass(2), pass(1)]);
  assert.deepEqual(page.element("passes-list").children.map((row) => row.open), [false, true, false]);
  page.renderPasses([pass(3), pass(1)]);
  assert.ok(page.element("passes-list").children.every((row) => !row.open));
});

test("missing and military routes remain honest without fabricated destinations", () => {
  const page = app();
  page.renderPasses([
    { ...pass(1), callsign: "OHU488", route: null },
    { ...pass(2), callsign: "TACTICAL", is_military: true, route: null }
  ]);
  const rows = page.element("passes-list").children;
  assert.match(rows[0].textContent, /Tuntematon operaattori.*OHU488.*Reitti ei tiedossa/);
  assert.match(rows[1].textContent, /Sotilaskone.*Reitti ei tiedossa/);
  assert.equal(rows[0].querySelector("a"), null);
});

test("live cards show the same route and metric units", () => {
  const page = app();
  page.renderAircraft([{ ...pass(1), latitude: 62, longitude: 27, altitude_ft: 3000, speed_knots: 100 }]);
  const card = page.element("aircraft-with-position").children[0];
  assert.match(card.textContent, /Finnair · Kuopio → Helsinki \(tietokantareitti\)/);
  assert.match(card.textContent, /914 m/);
  assert.match(card.textContent, /185 km\/h/);
});

test("all pages are fetched for the day, including more than 100 observed flights", async () => {
  const requests = [];
  const page = app(async (path) => {
    const url = new URL(path, "https://example.invalid");
    requests.push(url);
    return {
      ok: true,
      json: async () => url.searchParams.has("cursor")
        ? { passes: [pass(100)], next_cursor: null }
        : { passes: Array.from({ length: 100 }, (_, i) => pass(i)), next_cursor: "next-page" }
    };
  });
  const result = await page.fetchAllPasses("2026-09-01");
  page.renderPasses(result.passes);
  assert.equal(page.element("passes-list").children.length, 101);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get("date"), "2026-09-01");
  assert.equal(requests[1].searchParams.get("cursor"), "next-page");
});

test("broken API pagination cannot loop indefinitely", async () => {
  const page = app(async () => ({ ok: true, json: async () => ({ passes: [], next_cursor: "repeated" }) }));
  await assert.rejects(page.fetchAllPasses("2026-09-01"), /repeated a pagination cursor/);
});
