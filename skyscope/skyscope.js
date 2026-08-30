import {
  deriveReceiverState,
  formatDateTime,
  hasValidPosition,
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
  uniqueAircraft: document.querySelector("[data-unique-aircraft]"),
  passCount: document.querySelector("[data-pass-count]"),
  closestAircraft: document.querySelector("[data-closest-aircraft]"),
  closestDetail: document.querySelector("[data-closest-detail]"),
  liveCount: document.querySelector("[data-live-count]"),
  positionCount: document.querySelector("[data-position-count]"),
  noPositionCount: document.querySelector("[data-no-position-count]"),
  withPosition: document.querySelector("[data-aircraft-with-position]"),
  withoutPosition: document.querySelector("[data-aircraft-without-position]"),
  passesList: document.querySelector("[data-passes-list]")
};

const viewState = {
  data: null,
  requestFailed: false
};

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
  metrics.append(
    metric("Korkeus", hasFiniteNumber(aircraft.altitude_ft) ? `${formatNumber(aircraft.altitude_ft)} ft` : "–"),
    metric("Nopeus", hasFiniteNumber(aircraft.speed_knots) ? `${formatNumber(aircraft.speed_knots)} kt` : "–"),
    metric("Suunta", hasFiniteNumber(aircraft.track_deg) ? `${formatNumber(aircraft.track_deg, { maximumFractionDigits: 0 })}°` : "–"),
    metric("Signaali", hasFiniteNumber(aircraft.signal_db) ? `${formatNumber(aircraft.signal_db, { maximumFractionDigits: 1 })} dBFS` : "–")
  );

  if (hasPosition) {
    metrics.append(metric("Etäisyys", hasFiniteNumber(aircraft.distance_km) ? `${formatNumber(aircraft.distance_km, { maximumFractionDigits: 1 })} km` : "–"));
  }

  article.append(heading, metrics);
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

function passCard(pass) {
  const article = document.createElement("article");
  article.className = "pass-card card";

  const heading = document.createElement("div");
  heading.className = "pass-title-row";
  const titleWrap = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "pass-callsign";
  eyebrow.textContent = pass.callsign || "Tuntematon kutsutunnus";
  const title = document.createElement("h3");
  title.textContent = pass.icao || "–";
  titleWrap.append(eyebrow, title);
  const closest = document.createElement("strong");
  closest.className = "pass-distance";
  closest.textContent = hasFiniteNumber(pass.closest_distance_km)
    ? `${formatNumber(pass.closest_distance_km, { maximumFractionDigits: 1 })} km`
    : "Etäisyys ei saatavilla";
  heading.append(titleWrap, closest);

  const timeline = document.createElement("dl");
  timeline.className = "pass-timeline";
  timeline.append(
    metric("Ensimmäinen havainto", formatDateTime(pass.first_seen)),
    metric("Viimeinen havainto", formatDateTime(pass.last_seen)),
    metric("Lähimmillään", formatDateTime(pass.closest_at))
  );

  article.append(heading, timeline);
  return article;
}

function renderPasses(passes = []) {
  if (passes.length) {
    elements.passesList.replaceChildren(...passes.map(passCard));
    return;
  }
  const empty = emptyState("Ohituksia ei ole vielä saatavilla.");
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

  elements.closestAircraft.textContent = closest.callsign || closest.icao || "Tuntematon";
  const distance = hasFiniteNumber(closest.distance_km)
    ? `${formatNumber(closest.distance_km, { maximumFractionDigits: 1 })} km`
    : "etäisyys ei saatavilla";
  elements.closestDetail.textContent = `${distance} · ${formatDateTime(closest.at)}`;
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

async function refresh() {
  if (!apiBaseUrl) {
    render();
    return;
  }

  try {
    const [status, live, passes, stats] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/live"),
      fetchJson("/api/passes"),
      fetchJson("/api/stats")
    ]);
    viewState.data = { status, live, passes, stats };
    viewState.requestFailed = false;
  } catch (error) {
    viewState.requestFailed = true;
    console.warn("SkyScope-päivitys epäonnistui; säilytetään viimeisin onnistunut data.", error);
  }
  render();
}

refresh();
window.setInterval(refresh, POLL_INTERVAL_MS);
