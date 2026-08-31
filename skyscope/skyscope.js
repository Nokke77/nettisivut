import {
  aircraftOperatorLabel,
  aircraftOwnerLine,
  aircraftTypeLabel,
  deriveReceiverState,
  feetToMetres,
  formatDateTime,
  formatPassTimeRange,
  hasValidPosition,
  helsinkiDate,
  knotsToKmh,
  passRouteLabel,
  passTypeLabel,
  receiverStateLabels
} from "./state.mjs";

const POLL_INTERVAL_MS = 30_000;
const configuredApiBase = window.SKYSCOPE_CONFIG?.apiBaseUrl?.trim() || "";
const apiBaseUrl = configuredApiBase.replace(/\/$/, "");

const elements = {
  statusBadge: document.querySelector("[data-status-badge]"),
  statusLabel: document.querySelector("[data-status-label]"),
  lastUpdate: document.querySelector("[data-last-update]"),
  connectionNotice: document.querySelector("[data-connection-notice]"),
  statsDate: document.querySelector("[data-stats-date]"),
  selectedDate: document.querySelector("[data-selected-date]"),
  uniqueAircraft: document.querySelector("[data-unique-aircraft]"),
  passCount: document.querySelector("[data-pass-count]"),
  closestAircraft: document.querySelector("[data-closest-aircraft]"),
  closestDetail: document.querySelector("[data-closest-detail]"),
  liveCount: document.querySelector("[data-live-count]"),
  positionCount: document.querySelector("[data-position-count]"),
  noPositionCount: document.querySelector("[data-no-position-count]"),
  withPosition: document.querySelector("[data-aircraft-with-position]"),
  withoutPosition: document.querySelector("[data-aircraft-without-position]"),
  passesList: document.querySelector("[data-passes-list]"),
  passesDate: document.querySelector("[data-passes-date]"),
  passesCount: document.querySelector("[data-passes-count]")
};

const viewState = {
  data: null,
  requestFailed: false,
  selectedDate: helsinkiDate()
};

let refreshSequence = 0;

elements.selectedDate.value = viewState.selectedDate;
elements.selectedDate.max = viewState.selectedDate;

function formatDate(value) {
  if (!value) return "–";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fi-FI", { dateStyle: "long" }).format(date);
}

function formatNumber(value, options = {}) {
  if (value === null || value === undefined || value === "") return "–";
  const number = Number(value);
  if (!Number.isFinite(number)) return "–";
  return new Intl.NumberFormat("fi-FI", options).format(number);
}

function hasFiniteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function metric(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "aircraft-metric";
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  wrapper.append(term, detail);
  return wrapper;
}

function emptyState(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty-state";
  paragraph.textContent = message;
  return paragraph;
}

function aircraftIdentity(aircraft, { includeIcao = false } = {}) {
  const typeLabel = aircraftTypeLabel(aircraft);
  const ownerLine = aircraftOwnerLine(aircraft);
  const details = [
    ownerLine,
    includeIcao && aircraft?.icao ? `ICAO ${aircraft.icao}` : null
  ].filter(Boolean);

  if (!typeLabel && !details.length && aircraft?.is_military !== true) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "aircraft-identity";

  if (typeLabel) {
    const type = document.createElement("p");
    type.className = "aircraft-type";
    type.textContent = typeLabel;
    wrapper.append(type);
  }

  if (details.length) {
    const owner = document.createElement("p");
    owner.className = "aircraft-owner";
    owner.textContent = details.join(" · ");
    wrapper.append(owner);
  }

  if (aircraft?.is_military === true) {
    const flag = document.createElement("span");
    flag.className = "aircraft-flag";
    flag.textContent = "Tietokannassa sotilaskoneeksi merkitty";
    wrapper.append(flag);
  }

  return wrapper;
}

function aircraftCard(aircraft, hasPosition) {
  const article = document.createElement("article");
  article.className = "aircraft-card";

  const heading = document.createElement("div");
  heading.className = "aircraft-title-row";
  const title = document.createElement("h4");
  title.textContent = aircraft.callsign || "Tuntematon kutsutunnus";
  const icao = document.createElement("span");
  icao.className = "icao-code";
  icao.textContent = aircraft.icao || "–";
  heading.append(title, icao);

  const metrics = document.createElement("dl");
  metrics.className = "aircraft-metrics";
  const altitudeMetres = feetToMetres(aircraft.altitude_ft);
  const speedKmh = knotsToKmh(aircraft.speed_knots);
  metrics.append(
    metric("Korkeus", altitudeMetres !== null
      ? `${formatNumber(altitudeMetres, { maximumFractionDigits: 0 })} m`
      : "–"),
    metric("Nopeus", speedKmh !== null
      ? `${formatNumber(speedKmh, { maximumFractionDigits: 0 })} km/h`
      : "–"),
    metric("Suunta", hasFiniteNumber(aircraft.track_deg) ? `${formatNumber(aircraft.track_deg, { maximumFractionDigits: 0 })}°` : "–"),
    metric("Signaali", hasFiniteNumber(aircraft.signal_db) ? `${formatNumber(aircraft.signal_db, { maximumFractionDigits: 1 })} dBFS` : "–")
  );

  if (hasPosition) {
    metrics.append(metric("Etäisyys", hasFiniteNumber(aircraft.distance_km) ? `${formatNumber(aircraft.distance_km, { maximumFractionDigits: 1 })} km` : "–"));
  }

  const identity = aircraftIdentity(aircraft);
  article.append(heading);
  if (identity) article.append(identity);
  article.append(metrics);
  return article;
}

function renderAircraft(aircraft = []) {
  const withPosition = aircraft.filter(hasValidPosition);
  const withoutPosition = aircraft.filter((item) => !hasValidPosition(item));

  elements.liveCount.textContent = `${aircraft.length} ${aircraft.length === 1 ? "kone" : "konetta"}`;
  elements.positionCount.textContent = String(withPosition.length);
  elements.noPositionCount.textContent = String(withoutPosition.length);
  elements.withPosition.replaceChildren(...(withPosition.length
    ? withPosition.map((item) => aircraftCard(item, true))
    : [emptyState("Ei sijaintihavaintoja.")]));
  elements.withoutPosition.replaceChildren(...(withoutPosition.length
    ? withoutPosition.map((item) => aircraftCard(item, false))
    : [emptyState("Ei sijaintitiedottomia havaintoja.")]));
}

function altitudeRange(pass) {
  const minimum = feetToMetres(pass.min_altitude_ft);
  const maximum = feetToMetres(pass.max_altitude_ft);
  if (minimum === null && maximum === null) return "–";
  if (minimum === null || maximum === null || Math.round(minimum) === Math.round(maximum)) {
    const altitude = minimum ?? maximum;
    return `${formatNumber(altitude, { maximumFractionDigits: 0 })} m`;
  }
  return `${formatNumber(minimum, { maximumFractionDigits: 0 })}–${formatNumber(maximum, { maximumFractionDigits: 0 })} m`;
}

function compactItem(className, value) {
  const item = document.createElement("span");
  item.className = className;
  item.textContent = value;
  return item;
}

function passRow(pass) {
  const details = document.createElement("details");
  details.className = "pass-row card";

  const summary = document.createElement("summary");
  summary.className = "pass-summary";
  const main = document.createElement("span");
  main.className = "pass-summary-main";
  main.append(
    compactItem("pass-operator", aircraftOperatorLabel(pass)),
    compactItem("pass-callsign", pass.callsign || "Ei kutsutunnusta"),
    compactItem("pass-route", passRouteLabel(pass)),
    compactItem("pass-type", passTypeLabel(pass)),
    compactItem("pass-time-range", formatPassTimeRange(pass.first_seen, pass.last_seen))
  );
  const distance = compactItem(
    "pass-distance",
    hasFiniteNumber(pass.closest_distance_km)
      ? `${formatNumber(pass.closest_distance_km, { maximumFractionDigits: 1 })} km`
      : "Etäisyys ei tiedossa"
  );
  summary.append(main, distance);

  const technical = document.createElement("dl");
  technical.className = "pass-technical";
  technical.append(
    metric("Rekisteritunnus", pass.registration || "–"),
    metric("ICAO-tunnus", pass.icao || "–"),
    metric("Korkeus", altitudeRange(pass)),
    metric("Tyyppikoodi", pass.type_code || "–"),
    metric("Ensimmäinen havainto", formatDateTime(pass.first_seen)),
    metric("Viimeinen havainto", formatDateTime(pass.last_seen)),
    metric("Lähimmillään", formatDateTime(pass.closest_at)),
    metric("Tietokannan operaattori", pass.owner_operator || "–")
  );
  details.append(summary, technical);
  return details;
}

function renderPasses(passes = []) {
  elements.passesDate.textContent = formatDate(viewState.selectedDate);
  elements.passesCount.textContent = `${passes.length} ${passes.length === 1 ? "ohitus" : "ohitusta"}`;
  if (passes.length) {
    elements.passesList.replaceChildren(...passes.map(passRow));
    return;
  }
  const empty = emptyState("Valitulta päivältä ei ole ohituksia.");
  empty.classList.add("card");
  elements.passesList.replaceChildren(empty);
}

function renderStats(stats = {}) {
  elements.statsDate.textContent = formatDate(stats.date);
  elements.uniqueAircraft.textContent = formatNumber(stats.unique_aircraft_count);
  elements.passCount.textContent = formatNumber(stats.pass_count);

  const closest = stats.closest_aircraft;
  if (!closest) {
    elements.closestAircraft.textContent = "–";
    elements.closestDetail.textContent = "Päivän lähin havainto";
    return;
  }

  const typeLabel = aircraftTypeLabel(closest);
  elements.closestAircraft.textContent = closest.callsign || typeLabel || closest.icao || "Tuntematon";
  const distance = hasFiniteNumber(closest.distance_km)
    ? `${formatNumber(closest.distance_km, { maximumFractionDigits: 1 })} km`
    : "etäisyys ei saatavilla";
  const identity = [
    closest.callsign ? typeLabel : null,
    aircraftOwnerLine(closest),
    closest.is_military === true ? "sotilaskoneeksi merkitty" : null,
    distance,
    formatDateTime(closest.at)
  ].filter(Boolean);
  elements.closestDetail.textContent = identity.join(" · ");
}

function renderConnectionState() {
  if (!apiBaseUrl) {
    elements.statusBadge.dataset.state = "disconnected";
    elements.statusLabel.textContent = receiverStateLabels.disconnected;
    elements.connectionNotice.hidden = false;
    return;
  }

  const lastReceivedAt = viewState.data?.status?.received_at;
  const state = deriveReceiverState({
    lastReceivedAt,
    requestFailed: viewState.requestFailed
  });
  elements.statusBadge.dataset.state = state;
  elements.statusLabel.textContent = receiverStateLabels[state];
  elements.lastUpdate.textContent = formatDateTime(viewState.data?.status?.last_update);

  if (viewState.requestFailed && viewState.data) {
    elements.connectionNotice.textContent = "API-yhteydessä on tilapäinen häiriö. Näytetään viimeksi onnistuneesti haetut tiedot.";
    elements.connectionNotice.hidden = false;
  } else if (!viewState.data) {
    elements.connectionNotice.textContent = "SkyScope-dataa ei saatu ladattua. Yritetään automaattisesti uudelleen.";
    elements.connectionNotice.hidden = false;
  } else {
    elements.connectionNotice.hidden = true;
  }
}

function render() {
  renderConnectionState();
  if (!viewState.data) return;
  renderStats(viewState.data.stats);
  renderAircraft(viewState.data.live.aircraft);
  renderPasses(viewState.data.passes.passes);
}

async function fetchJson(path) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`SkyScope API returned ${response.status}`);
  return response.json();
}

async function fetchAllPasses(date) {
  const passes = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    const search = new URLSearchParams({ date, limit: "100" });
    if (cursor) search.set("cursor", cursor);
    const page = await fetchJson(`/api/passes?${search}`);
    if (!Array.isArray(page.passes)) throw new Error("SkyScope API returned invalid pass data");
    passes.push(...page.passes);
    cursor = page.next_cursor || null;
    if (cursor && seenCursors.has(cursor)) throw new Error("SkyScope API repeated a pagination cursor");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return { date, passes };
}

async function refresh() {
  if (!apiBaseUrl) {
    render();
    return;
  }

  const sequence = ++refreshSequence;
  const selectedDate = viewState.selectedDate;
  try {
    const [status, live, passes, stats] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/live"),
      fetchAllPasses(selectedDate),
      fetchJson(`/api/stats?${new URLSearchParams({ date: selectedDate })}`)
    ]);
    if (sequence !== refreshSequence) return;
    viewState.data = { status, live, passes, stats };
    viewState.requestFailed = false;
  } catch (error) {
    if (sequence !== refreshSequence) return;
    viewState.requestFailed = true;
    console.warn("SkyScope-päivitys epäonnistui; säilytetään viimeisin onnistunut data.", error);
  }
  render();
}

elements.selectedDate.addEventListener("change", () => {
  if (!elements.selectedDate.value) return;
  viewState.selectedDate = elements.selectedDate.value;
  refresh();
});

refresh();
window.setInterval(refresh, POLL_INTERVAL_MS);
