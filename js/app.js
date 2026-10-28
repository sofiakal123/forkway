import { Network } from "./network.js";
import { planTrips } from "./router.js";
import { StopSearch, geocode } from "./search.js";
import { TripMap } from "./map.js";
import { TripTracker } from "./live.js";
import { LiveData, liveResults, routesOf } from "./realtime.js";
import { saveNycMap, savedMapDate } from "./offline-map.js";

const RECENTS_KEY = "forkway-recents";
const MAX_RECENTS = 6;
const LIVE_TICK_MS = 5000;
const DATA_TICK_MS = 15_000;
const GEOCODE_DELAY_MS = 700; // Nominatim allows about one search a second
const NO_GPS_AFTER_MS = 30_000;
const LIVE_PLAN_WINDOW_MS = 20 * 60_000; // live times only help trips leaving about now
const MAX_ALERTS_SHOWN = 3;
const MAX_FORKS_ON_CARD = 3; // the trip screen lists them all

const els = {
  title: document.getElementById("title"),
  back: document.getElementById("back"),
  dataPill: document.getElementById("data-pill"),
  dataLabel: document.getElementById("data-label"),
  toast: document.getElementById("alert"),
  planView: document.getElementById("plan-view"),
  tripView: document.getElementById("trip-view"),
  form: document.getElementById("plan-form"),
  fromInput: document.getElementById("from-input"),
  toInput: document.getElementById("to-input"),
  useLocation: document.getElementById("use-location"),
  suggestions: document.getElementById("suggestions"),
  whenMode: document.getElementById("when-mode"),
  whenTime: document.getElementById("when-time"),
  planButton: document.getElementById("plan-button"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  recents: document.getElementById("recents"),
  recentList: document.getElementById("recent-list"),
  dataPanel: document.getElementById("data-panel"),
  footnote: document.getElementById("footnote"),
  map: document.getElementById("map"),
  sheet: document.getElementById("sheet-content"),
};

const state = {
  net: null,
  live: null, // live MTA data (LiveData)
  routeById: new Map(),
  serviceWeek: null,
  stopSearch: null,
  map: null,
  here: null, // latest GPS fix
  from: null, // chosen start, or null for current location
  to: null,
  results: null,
  trip: null, // the trip option being viewed
  choice: 0, // which exit choice is selected
  tracker: null,
  watchId: null,
  liveTimer: null,
  wakeLock: null,
  lastFixAt: 0,
  pickingStop: false,
  shownLeg: -1,
  savingMap: null, // { done, total } while saving the offline map
};

// --- Start up ------------------------------------------------------------------

async function boot() {
  registerServiceWorker();
  wireEvents();
  renderRecents();
  renderDataPill();
  locate();

  try {
    const res = await fetch("data/transit.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.net = new Network(data);
    state.stopSearch = new StopSearch(state.net);
    state.live = new LiveData(state.net);
    state.routeById = new Map(state.net.routes.map((r) => [r.id, r]));
    state.serviceWeek = formatFeedDate(data.serviceDates?.wd?.gtfs_subway);
  } catch (err) {
    console.error(err);
    setStatus("Couldn't load NYC transit data. Check your connection and reopen the app.", true);
    els.planButton.textContent = "Unavailable";
    return;
  }
  els.planButton.disabled = false;
  els.planButton.textContent = "See routes";
  els.footnote.textContent =
    "Live data from the MTA. Map data © OpenStreetMap contributors, via OpenFreeMap. " +
    "Live bus times aren't included: the MTA's bus feed needs a server.";
  renderDataPanel();
  renderDataPill();

  state.live.refresh([]).then(renderData);
  setInterval(dataTick, DATA_TICK_MS);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Offline mode unavailable:", err));
  }
}

function locate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.here = fixOf(pos);
    },
    () => {
      if (!state.from) els.fromInput.placeholder = "Starting point (location is off)";
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function fixOf(pos) {
  return { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
}

// --- Live or saved data ---------------------------------------------------------------

const DATA_LABELS = {
  live: "Live",
  connecting: "Connecting",
  offline: "Offline",
  off: "Saved data",
};

function renderData() {
  renderDataPill();
  renderDataPanel();
}

function renderDataPill() {
  const st = state.live?.state ?? "connecting";
  els.dataPill.dataset.state = st;
  els.dataLabel.textContent = DATA_LABELS[st];
  els.dataPill.setAttribute(
    "aria-label",
    st === "off" ? "Using saved data only. Tap to use live data." : `${DATA_LABELS[st]}. Tap to use saved data only.`
  );
  state.map?.setOffline(!state.live?.usable);
}

function renderDataPanel() {
  if (!state.live) return;
  const live = state.live;
  const st = live.state;

  const liveRow = row(
    "Live MTA data",
    {
      live: `Train times and alerts · ${live.updatedAt ? clock(live.updatedAt) : "now"}`,
      connecting: "Connecting to the MTA…",
      offline: "No signal: using saved schedules",
      off: "Off: using saved schedules and map",
    }[st]
  );
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.checked = live.enabled;
  toggle.setAttribute("aria-label", "Use live MTA data");
  toggle.addEventListener("change", () => setLiveEnabled(toggle.checked));
  liveRow.append(toggle);

  const scheduleRow = row("Saved schedules", `Every line · ${state.serviceWeek} timetable`);
  scheduleRow.append(el("span", "tag", "Saved"));

  const saved = savedMapDate();
  let mapDetail = saved ? `Saved ${saved.toLocaleDateString([], { month: "short", day: "numeric" })}` : "Not saved yet · about 10 MB";
  if (state.savingMap) mapDetail = `Saving… ${Math.round((state.savingMap.done / state.savingMap.total) * 100)}%`;
  const mapRow = row("Offline NYC map", mapDetail);
  const save = button("small-button", saved ? "Update" : "Save", saveMap);
  save.disabled = Boolean(state.savingMap) || !("caches" in window) || !navigator.onLine;
  mapRow.append(save);

  const rows = [liveRow, scheduleRow, mapRow];
  if (state.savingMap) {
    const bar = el("div", "progress");
    const fill = el("span");
    fill.style.width = `${(state.savingMap.done / state.savingMap.total) * 100}%`;
    bar.append(fill);
    mapRow.querySelector(".row-text").append(bar);
  }
  els.dataPanel.replaceChildren(...rows);
}

function row(title, detail) {
  const r = el("div", "row");
  const text = el("div", "row-text");
  text.append(el("div", "row-title", title), el("div", "row-detail", detail));
  r.append(text);
  return r;
}

function setLiveEnabled(on) {
  state.live.setEnabled(on);
  showToast(on ? "Live data on" : "Using saved data only: schedules and the saved map");
  renderData();
  if (state.results) applyLive();
  if (on) state.live.refresh(state.results ? routesOf(state.results.scheduled) : [], { force: true }).then(() => {
    renderData();
    if (state.results) applyLive();
    if (state.tracker) renderLive();
  });
  if (state.trip && !state.tracker) renderPreview();
  if (state.tracker) renderLive();
}

async function saveMap() {
  if (state.savingMap) return;
  state.savingMap = { done: 0, total: 1 };
  renderDataPanel();
  let lastRender = 0;
  try {
    await saveNycMap((done, total) => {
      state.savingMap = { done, total };
      if (Date.now() - lastRender > 250 || done === total) {
        lastRender = Date.now();
        renderDataPanel();
      }
    });
    showToast("NYC map saved. It works with no signal now.");
  } catch (err) {
    showToast(`Couldn't save the map: ${err.message}`);
  }
  state.savingMap = null;
  renderDataPanel();
}

// Every few seconds: keep the data status and live trip times current
function dataTick() {
  renderData();
  const r = state.results;
  if (r && state.live?.usable && !state.tracker && Math.abs(r.time - Date.now()) < LIVE_PLAN_WINDOW_MS) {
    state.live.refresh(routesOf(r.scheduled)).then((changed) => changed && applyLive());
  }
}

// Planner results with live train times (or back to the schedule)
function applyLive() {
  const r = state.results;
  if (!r) return;
  const useLive = state.live?.usable && Math.abs(r.time - Date.now()) < LIVE_PLAN_WINDOW_MS;
  r.trips = useLive ? liveResults(r.scheduled, state.live) : r.scheduled;
  renderResults();
  if (state.trip && !state.tracker) {
    // Keep the open trip in step with the new times
    const updated = r.trips.find((t) => t.first?.pattern === state.trip.first?.pattern && t.walkOnly === state.trip.walkOnly);
    if (updated) {
      state.trip = updated;
      renderPreview();
    }
  }
}

// --- Choosing places ---------------------------------------------------------------

let activeInput = null;
let geocodeTimer = null;
let geocodeAbort = null;

// typed: the text changed, so any place chosen earlier no longer applies
function onPlaceInput(input, typed) {
  activeInput = input;
  if (typed) {
    if (input === els.fromInput) state.from = null;
    else state.to = null;
  }

  const text = input.value.trim();
  clearTimeout(geocodeTimer);
  geocodeAbort?.abort();
  if (!state.stopSearch || text.length < 2) {
    renderSuggestions(input, [], []);
    return;
  }

  const stops = state.stopSearch.find(text, 6);
  renderSuggestions(input, stops, []);

  if (text.length >= 4 && navigator.onLine && state.live?.enabled) {
    geocodeTimer = setTimeout(async () => {
      geocodeAbort = new AbortController();
      try {
        const places = await geocode(text, geocodeAbort.signal);
        if (activeInput === input && input.value.trim() === text) renderSuggestions(input, stops, places);
      } catch {
        // Offline or blocked: stop results are still there
      }
    }, GEOCODE_DELAY_MS);
  }
}

function renderSuggestions(input, stops, places) {
  els.suggestions.innerHTML = "";
  const items = [];
  if (input === els.fromInput) items.push({ name: "Current location", detail: "Use GPS", current: true });
  if (stops.length) items.push({ group: "Stops and stations" }, ...stops);
  if (places.length) items.push({ group: "Places" }, ...places);

  for (const item of items) {
    const li = document.createElement("li");
    if (item.group) {
      li.className = "group label";
      li.textContent = item.group;
    } else {
      li.setAttribute("role", "option");
      li.append(el("div", "suggestion-name", item.name), el("div", "suggestion-detail", item.detail ?? ""));
      // pointerdown, so it fires before the input loses focus
      li.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        choosePlace(input, item);
      });
    }
    els.suggestions.append(li);
  }
  els.suggestions.hidden = items.length === 0 || (input === els.fromInput && items.length === 1 && !input.value);
}

function choosePlace(input, item) {
  els.suggestions.hidden = true;
  if (input === els.fromInput) {
    state.from = item.current ? null : { name: item.name, lat: item.lat, lon: item.lon };
    input.value = item.current ? "" : item.name;
    if (item.current) locate();
    els.toInput.focus();
  } else {
    state.to = { name: item.name, lat: item.lat, lon: item.lon };
    input.value = item.name;
    input.blur();
    plan();
  }
}

// --- Planning ---------------------------------------------------------------------

function plan() {
  if (!state.net) return;
  const origin = state.from ?? (state.here ? { name: "Current location", ...state.here } : null);
  if (!origin) {
    setStatus("Choose a starting point, or allow location access.", true);
    return;
  }
  if (!state.to) {
    setStatus("Pick your destination from the list as you type.", true);
    return;
  }
  const time = els.whenMode.value === "at" && els.whenTime.value ? new Date(els.whenTime.value) : new Date();

  setStatus("Finding routes…");
  els.results.innerHTML = "";
  // Let the status show before the (brief) heavy lifting
  setTimeout(async () => {
    const { trips } = planTrips(state.net, origin, state.to, time);
    state.results = { trips, scheduled: trips, origin, dest: state.to, time };
    saveRecent(state.to);
    renderResults();
    setStatus(trips.length ? "" : "No routes found. Try a nearby stop or a different time.", trips.length === 0);

    // Schedule answers show at once; live train times follow when they arrive
    if (trips.length && state.live.usable && Math.abs(time - Date.now()) < LIVE_PLAN_WINDOW_MS) {
      await state.live.refresh(routesOf(trips));
      if (state.results?.scheduled === trips) applyLive();
      renderData();
    }
  }, 30);
}

function renderResults() {
  const cards = state.results.trips.map((trip) => {
    const best = trip.best;
    const card = el("button", "trip-card");
    card.type = "button";

    const head = el("div", "trip-head");
    head.append(minutesEl(best.minutes), el("div", "arrive", `Arrive ${clock(best.arrive)}`));
    const chips = el("div", "chips");
    chips.append(...legChips(best.legs));
    card.append(head, chips);

    const firstRide = best.legs.find((l) => l.kind === "ride");
    const sub = el("div", "trip-sub", trip.walkOnly ? "Walk the whole way" : `${firstRide.fromStop.name} · ${clock(firstRide.board)}  `);
    if (firstRide?.live) sub.append(el("span", "tag live", "live"));
    card.append(sub);

    const alerts = tripAlerts(trip.choices);
    if (alerts.length) card.append(el("div", "alert-count", `${alerts.length} service alert${alerts.length === 1 ? "" : "s"}`));

    // The forks: every place you could switch off the first ride
    if (trip.choices.length > 1) {
      const forks = el("div", "forks");
      forks.append(el("div", "label", `${trip.choices.length} places to switch`));
      const list = el("div", "fork-list");
      for (const choice of trip.choices.slice(0, MAX_FORKS_ON_CARD)) {
        const item = el("span", "fork-item");
        item.append(choice.exit.name, ...continuationChips(choice, true));
        list.append(item);
      }
      const more = trip.choices.length - MAX_FORKS_ON_CARD;
      if (more > 0) list.append(el("span", "sep", `+${more} more`));
      forks.append(list);
      card.append(forks);
    }

    card.addEventListener("click", () => openTrip(trip));
    return card;
  });
  els.results.replaceChildren(...cards);
}

// --- A trip: preview -----------------------------------------------------------------

function openTrip(trip) {
  state.trip = trip;
  state.choice = Math.max(0, trip.choices.findIndex((c) => c.fastest));
  showView("trip");
  history.pushState({ view: "trip" }, "");
  state.map ??= new TripMap(els.map, { offline: !state.live?.usable });
  state.map.resize();
  renderPreview(true);
}

function renderPreview(fit = false) {
  const trip = state.trip;
  const choice = trip.choices[Math.min(state.choice, trip.choices.length - 1)];
  state.map.show(state.net, choice, { exits: otherExits(trip.choices, choice), fit });

  const sheet = [];
  const summary = el("div", "summary");
  summary.append(minutesEl(choice.minutes));
  const times = el("div", "summary-times");
  times.append(el("div", null, `${clock(choice.depart)} – ${clock(choice.arrive)}`), sourceTag(choice.live));
  summary.append(times);
  sheet.push(summary);

  if (trip.choices.length > 1) {
    const ride = choice.legs.find((l) => l.kind === "ride");
    sheet.push(
      choicesSection(ride, trip.choices, choice.exit.position, (picked) => {
        state.choice = trip.choices.indexOf(picked);
        renderPreview();
      })
    );
  }

  const alerts = alertsSection(tripAlerts([choice]));
  if (alerts) sheet.push(alerts);

  sheet.push(legList(choice.legs, -1));
  sheet.push(button("primary wide", "Start trip", startLive));
  sheet.push(compareLinks(state.results.origin, state.results.dest));
  els.sheet.replaceChildren(...sheet);
}

// "Get off the 4 at": one row per exit
function choicesSection(ride, choices, chosenPosition, onPick) {
  const section = el("div", "section");
  const title = el("div", "label");
  title.append("Get off the", routeBadge(ride.route, true), "at");
  section.append(title);

  const list = el("div", "choices");
  const fastest = Math.min(...choices.map((c) => c.arrive.getTime()));
  for (const choice of choices) {
    const selected = choice.exit.position === chosenPosition;
    const item = el("button", `choice${selected ? " selected" : ""}`);
    item.type = "button";
    item.setAttribute("aria-pressed", String(selected));

    const middle = el("div");
    middle.append(el("div", "choice-stop", choice.exit.name));
    const then = el("div", "choice-then");
    then.append("then", ...continuationChips(choice, true));
    middle.append(then);

    const time = el("div", "choice-time", clock(choice.arrive));
    const later = Math.round((choice.arrive.getTime() - fastest) / 60000);
    time.append(later <= 0 ? el("small", "best", "fastest") : el("small", null, `+${later} min`));

    item.append(el("span", "choice-radio"), middle, time);
    item.addEventListener("click", () => onPick(choice));
    list.append(item);
  }
  section.append(list);
  return section;
}

function otherExits(choices, selected) {
  return choices
    .filter((c) => c !== selected)
    .map((c) => {
      const s = c.exit.stop;
      return { lat: state.net.lat[s], lon: state.net.lon[s], label: c.exit.then };
    });
}

// The same trip in Google Maps or Citymapper (opens their app if installed)
function compareLinks(origin, dest) {
  const wrap = el("div", "compare");
  const from = `${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}`;
  const to = `${dest.lat.toFixed(5)},${dest.lon.toFixed(5)}`;
  const links = [
    ["Google Maps", `https://www.google.com/maps/dir/?api=1&origin=${from}&destination=${to}&travelmode=transit`],
    ["Citymapper", `https://citymapper.com/directions?startcoord=${from}&endcoord=${to}&endname=${encodeURIComponent(dest.name)}`],
  ];
  wrap.append("Compare in");
  for (const [name, href] of links) {
    const a = el("a", null, name);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    wrap.append(a);
  }
  return wrap;
}

// --- Service alerts -----------------------------------------------------------------------

function tripAlerts(choices) {
  if (!state.live?.usable) return [];
  const ids = new Set();
  for (const c of choices) for (const leg of c.legs) if (leg.kind === "ride") ids.add(leg.route.id);
  return state.live.alertsFor([...ids]);
}

function alertsSection(alerts) {
  if (!alerts.length) return null;
  const section = el("div", "alerts");
  for (const alert of alerts.slice(0, MAX_ALERTS_SHOWN)) {
    const item = el("details", "alert-item");
    const summary = el("summary");
    const title = el("div", "alert-title");
    title.append(...withBadges(alert.title));
    if (alert.type) title.append(el("span", "alert-type label", alert.type));
    summary.append(title);
    item.append(summary);
    if (alert.text) {
      const text = el("div", "alert-text");
      text.append(...withBadges(alert.text));
      item.append(text);
    }
    section.append(item);
  }
  if (alerts.length > MAX_ALERTS_SHOWN) section.append(el("div", "fine", `${alerts.length - MAX_ALERTS_SHOWN} more alerts on these lines`));
  return section;
}

// The MTA writes lines as "[4]": show those as line badges
function withBadges(text) {
  return text.split(/\[([A-Za-z0-9]+)\]/).map((part, k) => {
    const route = k % 2 ? state.routeById.get(part.toUpperCase()) : null;
    if (k % 2 === 0) return part;
    return route ? routeBadge(route, true) : `[${part}]`;
  });
}

// --- A trip: live -----------------------------------------------------------------------

function startLive() {
  const choice = state.trip.choices[state.choice];
  state.tracker = new TripTracker(state.net, choice, state.results.dest, state.live);
  state.pickingStop = false;
  state.shownLeg = -1;
  state.lastFixAt = 0;
  els.title.textContent = "On your way";

  if (navigator.geolocation) {
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = fixOf(pos);
        state.here = fix;
        state.lastFixAt = Date.now();
        state.tracker?.locate(fix);
        state.map.showYou(fix);
        renderLive();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }
  state.liveTimer = setInterval(liveTick, LIVE_TICK_MS);
  keepScreenOn();
  liveTick();
}

// Fetch fresh live data for the lines still ahead (throttled inside), then redraw
function liveTick() {
  const tracker = state.tracker;
  if (!tracker) return;
  if (state.live.usable) {
    const ids = [...new Set(tracker.legs.slice(tracker.legIndex).filter((l) => l.kind === "ride").map((l) => l.route.id))];
    state.live.refresh(ids).then((changed) => {
      renderDataPill();
      if (changed) renderLive();
    });
  }
  renderLive();
}

function stopLive() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  clearInterval(state.liveTimer);
  state.watchId = null;
  state.liveTimer = null;
  state.tracker = null;
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  els.toast.hidden = true;
}

function renderLive() {
  const tracker = state.tracker;
  if (!tracker) return;
  const now = new Date();
  const st = tracker.status(now);
  const net = state.net;

  // Redraw the map when the trip moves on to a new leg
  const remaining = { legs: tracker.legs.slice(tracker.legIndex) };
  if (remaining.legs.length) {
    const exits = (st.choices ?? [])
      .filter((c) => c.exit.position !== st.chosenExit)
      .map((c) => ({ lat: net.lat[c.exit.stop], lon: net.lon[c.exit.stop], label: c.exit.then }));
    state.map.show(net, remaining, { exits, fit: state.shownLeg !== tracker.legIndex });
    state.shownLeg = tracker.legIndex;
  }

  if (st.alert === "next") showToast(`Next stop: ${st.leg.toStop.name}. Get ready to get off.`, [200, 100, 200]);
  if (st.alert === "now") showToast(`Get off now at ${st.leg.toStop.name}`, [500, 200, 500, 200, 500]);

  const sheet = [];
  if (st.phase === "done") {
    const card = el("div", "now-card");
    card.append(el("div", "now-title", "You've arrived"), el("div", "now-detail", state.results.dest.name));
    sheet.push(card, button("primary wide", "Done", endTrip));
    els.sheet.replaceChildren(...sheet);
    return;
  }

  sheet.push(nowCard(st));

  if (st.choices && st.choices.length > 0) {
    sheet.push(
      choicesSection(st.leg, st.choices, st.chosenExit, (picked) => {
        tracker.chooseExit(picked);
        els.toast.hidden = true;
        renderLive();
      })
    );
  }

  if (state.pickingStop && st.leg.kind === "ride") sheet.push(stopPicker(st));

  const alerts = alertsSection(tripAlerts([{ legs: remaining.legs }]));
  if (alerts) sheet.push(alerts);

  sheet.push(legList(tracker.legs, tracker.legIndex));
  sheet.push(button("secondary wide", "End trip", endTrip));
  els.sheet.replaceChildren(...sheet);
}

// The big "what to do now" card
function nowCard(st) {
  const card = el("div", "now-card");
  const title = el("div", "now-title");
  const detail = el("div", "now-detail");
  const actions = el("div", "button-row");

  if (st.phase === "walk") {
    const leg = st.leg;
    card.append(el("div", "label", "Walk"));
    title.append(st.final ? "To your destination" : `To ${leg.to.name}`);
    const minutes = Math.max(1, Math.round(leg.seconds / 60));
    detail.textContent =
      st.metersLeft != null ? `About ${Math.round(st.metersLeft)} m to go` : `About ${minutes} min · ${Math.round(leg.meters)} m`;
    card.append(title, detail);
    actions.append(
      button("primary", st.final ? "I've arrived" : "I'm at the stop", () => {
        state.tracker.arrivedAtStop();
        renderLive();
      })
    );
  } else if (st.phase === "wait") {
    card.append(el("div", "label", `Wait at ${st.leg.fromStop.name}`));
    title.append(routeBadge(st.leg.route), `toward ${headsign(st.leg.headsign)}`);
    card.append(title);
    if (st.nextTrains?.length) {
      const trains = el("div", "next-trains");
      trains.append(st.nextTrains.join(" · "), el("small", null, "min"), el("span", "tag live", "live"));
      card.append(trains);
    } else {
      detail.textContent =
        `Runs about every ${st.headwayMinutes} min` + (st.waitMinutes > 0 ? `, next in about ${st.waitMinutes} min.` : ".");
      card.append(detail, el("div", "now-note", "Estimated from the schedule."));
    }
    actions.append(
      button("primary", "I'm on board", () => {
        state.tracker.boardedNow(new Date());
        renderLive();
      })
    );
  } else {
    const exitName = st.leg.toStop.name;
    if (st.phase === "getoff") {
      card.classList.add("getoff");
      card.append(el("div", "label", "Get off now"));
      title.append(exitName);
      detail.textContent = `Then ${describeNext(state.tracker)}.`;
      card.append(title, detail);
    } else {
      card.append(el("div", "label", st.nextStop ? `Next stop · ${st.nextStop}` : `Toward ${headsign(st.leg.headsign)}`));
      title.append(routeBadge(st.leg.route), `${st.stopsLeft} stop${st.stopsLeft === 1 ? "" : "s"} to ${exitName}`);
      detail.textContent = `Get off around ${clock(st.leg.arrive)}`;
      if (st.leg.live) detail.append("  ", el("span", "tag live", "live"));
      const gpsQuiet = Date.now() - state.lastFixAt > NO_GPS_AFTER_MS;
      const note =
        st.source === "live"
          ? "Following your train with live MTA data."
          : st.source === "gps" && !gpsQuiet
            ? "Position from GPS."
            : "No signal, so position is estimated from the schedule. Tap I'm here if it's off.";
      card.append(title, detail, el("div", "now-note", note));
      actions.append(
        button("secondary", state.pickingStop ? "Close" : "I'm here…", () => {
          state.pickingStop = !state.pickingStop;
          renderLive();
        })
      );
    }
    actions.append(
      button("primary", "I got off", () => {
        state.tracker.gotOff();
        els.toast.hidden = true;
        renderLive();
      })
    );
  }
  card.append(actions);
  return card;
}

// "I'm here": the stops from here to the end of the line
function stopPicker(st) {
  const list = el("ul", "list stop-picker");
  const pattern = st.pattern;
  for (let j = st.position; j < pattern.stops.length; j++) {
    const li = document.createElement("li");
    const b = button(null, state.net.stopName[pattern.stops[j]], () => {
      state.tracker.atPosition(j, new Date());
      state.pickingStop = false;
      renderLive();
    });
    if (j === st.chosenExit) b.append(el("span", "exit-mark", "your exit"));
    li.append(b);
    list.append(li);
  }
  return list;
}

function describeNext(tracker) {
  const next = tracker.legs[tracker.legIndex + 1];
  if (!next) return "you're there";
  if (next.kind === "walk") {
    const after = tracker.legs[tracker.legIndex + 2];
    return after?.kind === "ride" ? `walk to ${next.to.name} for the ${after.route.name}` : "walk to your destination";
  }
  return `take the ${next.route.name}`;
}

function endTrip() {
  stopLive();
  history.back();
}

function showToast(text, vibrate = null) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  if (vibrate) navigator.vibrate?.(vibrate);
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (els.toast.hidden = true), vibrate ? 12000 : 3500);
}

async function keepScreenOn() {
  try {
    state.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // Not supported; the screen may sleep
  }
}

// --- Shared pieces ------------------------------------------------------------------------

function legList(legs, currentIndex) {
  const list = el("ol", "legs");
  legs.forEach((leg, i) => {
    const li = el("li", `leg ${leg.kind}`);
    if (currentIndex >= 0 && i < currentIndex) li.classList.add("done");
    if (i === currentIndex) li.classList.add("current");
    const icon = el("div", "leg-icon");
    const main = el("div");

    if (leg.kind === "walk") {
      icon.append(walkIcon());
      const last = i === legs.length - 1;
      main.append(el("div", "leg-main", last ? "Walk to your destination" : `Walk to ${leg.to.name}`));
      main.append(el("div", "leg-detail", `${Math.max(1, Math.round(leg.seconds / 60))} min · ${Math.round(leg.meters)} m`));
    } else {
      li.style.setProperty("--leg-color", `#${leg.route.color}`);
      icon.append(routeBadge(leg.route));
      main.append(el("div", "leg-main", `toward ${headsign(leg.headsign)}`));
      const stops = el("div", "leg-stops");
      stops.append(stopLine(leg.fromStop.name, leg.board), stopLine(leg.toStop.name, leg.arrive));
      main.append(stops);
      const count = leg.to - leg.from;
      const headway = leg.headway ?? Math.round((leg.wait * 2) / 60);
      const detail = el(
        "div",
        "leg-detail",
        `${count} stop${count === 1 ? "" : "s"} · ${Math.round((leg.arrive - leg.board) / 60000)} min · every ~${headway} min  `
      );
      if (leg.live) detail.append(el("span", "tag live", "live train"));
      main.append(detail);
    }
    li.append(icon, main);
    list.append(li);
  });
  return list;
}

function stopLine(name, time) {
  const line = el("div", "leg-stop");
  const t = el("time", null, clock(time));
  line.append(el("span", null, name), t);
  return line;
}

function minutesEl(minutes) {
  const m = el("div", "minutes", String(minutes));
  m.append(el("small", null, "min"));
  return m;
}

function sourceTag(live) {
  return live ? el("span", "tag live", "live times") : el("span", "tag", "schedule");
}

// Small icons for a trip's legs: 4 › Bx11 (walks only when they're a real part of it)
const NOTABLE_WALK_SECONDS = 3 * 60;
function legChips(legs) {
  const shown = legs.filter((leg) => leg.kind === "ride" || leg.seconds >= NOTABLE_WALK_SECONDS || legs.length === 1);
  const chips = [];
  shown.forEach((leg, i) => {
    if (i) chips.push(el("span", "sep", "›"));
    chips.push(leg.kind === "walk" ? walkIcon() : routeBadge(leg.route));
  });
  return chips;
}

// Bus signs are often capitals and abbreviated: "WASHNGTN HTS G W BRIDGE via E 174 ST"
function headsign(text) {
  const main = text.split(/\s+via\s+/i)[0].trim();
  if (main !== main.toUpperCase()) return main;
  return main.toLowerCase().replace(/\b([a-z])([a-z]*)/g, (_, first, rest) => first.toUpperCase() + rest);
}

// What you'd take after an exit: route badges, or "walk"
function continuationChips(choice, small) {
  const rides = choice.legs.filter((l) => l.kind === "ride").slice(1);
  if (rides.length === 0) return [el("span", null, "walk")];
  return rides.map((l) => routeBadge(l.route, small));
}

function routeBadge(route, small = false) {
  const badge = el("span", `route ${route.mode}${small ? " small" : ""}`, route.name);
  badge.style.background = `#${route.color}`;
  badge.style.color = `#${route.text}`;
  return badge;
}

function walkIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "walk-icon");
  svg.setAttribute("aria-label", "Walk");
  svg.innerHTML =
    '<circle cx="13" cy="4" r="2"/><path d="M9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6a2 2 0 0 0-2.4-.8L6 8.3V13h2V9.6l1.8-.7"/>';
  return svg;
}

function button(className, text, onClick) {
  const b = el("button", className, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clock(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatFeedDate(yyyymmdd) {
  if (!yyyymmdd) return "the current timetable";
  const d = new Date(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8));
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

// --- Views and navigation -------------------------------------------------------------------

function showView(name) {
  const trip = name === "trip";
  els.planView.hidden = trip;
  els.tripView.hidden = !trip;
  els.back.hidden = !trip;
  els.title.textContent = trip ? "Trip" : "forkway";
  if (!trip) state.trip = null;
}

// Android's back button: from a trip, back to the results
window.addEventListener("popstate", () => {
  if (state.tracker && !confirm("End this trip?")) {
    history.pushState({ view: "trip" }, "");
    return;
  }
  stopLive();
  showView("plan");
});

// --- Recent destinations (kept on this phone only) ----------------------------------------------

function loadRecents() {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY)) ?? [];
  } catch {
    return [];
  }
}

function saveRecent(place) {
  const recents = [place, ...loadRecents().filter((p) => p.name !== place.name)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // Storage unavailable; recents are a convenience
  }
  renderRecents();
}

function renderRecents() {
  const recents = loadRecents();
  els.recents.hidden = recents.length === 0;
  els.recentList.replaceChildren(
    ...recents.map((place) => {
      const li = document.createElement("li");
      li.append(
        button(null, place.name, () => {
          state.to = place;
          els.toInput.value = place.name;
          plan();
        })
      );
      return li;
    })
  );
}

// --- Events -----------------------------------------------------------------------------------------

function wireEvents() {
  for (const input of [els.fromInput, els.toInput]) {
    input.addEventListener("input", () => onPlaceInput(input, true));
    input.addEventListener("focus", () => onPlaceInput(input, false));
    input.addEventListener("blur", () => setTimeout(() => (els.suggestions.hidden = true), 150));
  }
  els.useLocation.addEventListener("click", () => {
    state.from = null;
    els.fromInput.value = "";
    els.fromInput.placeholder = "Current location";
    locate();
  });
  els.whenMode.addEventListener("change", () => {
    const at = els.whenMode.value === "at";
    els.whenTime.hidden = !at;
    if (at && !els.whenTime.value) {
      const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
      els.whenTime.value = local.toISOString().slice(0, 16);
    }
  });
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    plan();
  });
  els.back.addEventListener("click", () => history.back());
  els.dataPill.addEventListener("click", () => state.live && setLiveEnabled(!state.live.enabled));
  for (const type of ["online", "offline"]) {
    window.addEventListener(type, () => {
      renderData();
      if (type === "online") state.live?.refresh(state.results ? routesOf(state.results.scheduled) : [], { force: true }).then(renderData);
      if (state.results) applyLive();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.tracker) {
      keepScreenOn();
      liveTick();
    }
  });
}

boot();
