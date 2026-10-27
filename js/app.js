import { Network } from "./network.js";
import { planTrips } from "./router.js";
import { StopSearch, geocode } from "./search.js";
import { TripMap } from "./map.js";
import { TripTracker } from "./live.js";

const RECENTS_KEY = "forkway-recents";
const MAX_RECENTS = 6;
const LIVE_TICK_MS = 5000;
const GEOCODE_DELAY_MS = 700; // Nominatim allows about one search a second
const NO_GPS_AFTER_MS = 30_000;

const els = {
  title: document.getElementById("title"),
  back: document.getElementById("back"),
  alert: document.getElementById("alert"),
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
  footnote: document.getElementById("footnote"),
  map: document.getElementById("map"),
  sheet: document.getElementById("sheet-content"),
};

const state = {
  net: null,
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
};

// --- Start up ------------------------------------------------------------------

async function boot() {
  registerServiceWorker();
  wireEvents();
  renderRecents();
  locate();

  try {
    const res = await fetch("data/transit.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.net = new Network(data);
    state.stopSearch = new StopSearch(state.net);
    els.footnote.textContent =
      `Schedules from the MTA for the week of ${formatFeedDate(data.serviceDates?.wd?.gtfs_subway)}. ` +
      "Times are estimated from the timetable, not live tracking. Map © OpenStreetMap contributors.";
  } catch (err) {
    console.error(err);
    setStatus("Couldn't load NYC transit data. Check your connection and reopen the app.", true);
    els.planButton.textContent = "Unavailable";
    return;
  }
  els.planButton.disabled = false;
  els.planButton.textContent = "See routes";
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

  if (text.length >= 4 && navigator.onLine) {
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
      li.className = "group";
      li.textContent = item.group;
    } else {
      li.setAttribute("role", "option");
      const name = document.createElement("div");
      name.className = "suggestion-name";
      name.textContent = item.name;
      const detail = document.createElement("div");
      detail.className = "suggestion-detail";
      detail.textContent = item.detail ?? "";
      li.append(name, detail);
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
  setTimeout(() => {
    const { trips } = planTrips(state.net, origin, state.to, time);
    state.results = { trips, origin, dest: state.to, time };
    saveRecent(state.to);
    renderResults();
    setStatus(trips.length ? "" : "No routes found. Try a nearby stop or a different time.", trips.length === 0);
  }, 30);
}

function renderResults() {
  els.results.innerHTML = "";
  for (const trip of state.results.trips) {
    const best = trip.best;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "trip-card";

    const top = el("div", "trip-top");
    const legs = el("div", "trip-legs");
    legs.append(...legChips(best.legs));
    const time = el("div", "trip-time");
    time.innerHTML = `<div class="trip-minutes">${best.minutes} <small>min</small></div>`;
    time.append(el("div", "trip-arrive", `Arrive ${clock(best.arrive)}`));
    top.append(legs, time);
    card.append(top);

    const firstRide = best.legs.find((l) => l.kind === "ride");
    card.append(
      el(
        "div",
        "trip-sub",
        trip.walkOnly ? "Walk the whole way" : `Board at ${firstRide.fromStop.name} at about ${clock(firstRide.board)}`
      )
    );

    // The forks: every place you could switch off the first ride
    if (trip.choices.length > 1) {
      const fork = el("div", "fork-summary");
      const label = el("strong", null, `${trip.choices.length} places to switch`);
      fork.append(label, el("span", "sep", "·"));
      trip.choices.forEach((choice, i) => {
        if (i) fork.append(el("span", "sep", "/"));
        fork.append(el("span", null, choice.exit.name), ...continuationChips(choice, true));
      });
      card.append(fork);
    }

    card.addEventListener("click", () => openTrip(trip));
    els.results.append(card);
  }
}

// --- A trip: preview -----------------------------------------------------------------

function openTrip(trip) {
  state.trip = trip;
  state.choice = Math.max(0, trip.choices.findIndex((c) => c.fastest));
  showView("trip");
  history.pushState({ view: "trip" }, "");
  state.map ??= new TripMap(els.map);
  state.map.resize();
  renderPreview(true);
}

function renderPreview(fit = false) {
  const trip = state.trip;
  const choice = trip.choices[state.choice];
  state.map.show(state.net, choice, { exits: otherExits(trip.choices, choice), fit });

  const sheet = [];
  const summary = el("div", "summary");
  summary.innerHTML = `<div class="summary-minutes">${choice.minutes} min</div>`;
  summary.append(el("div", "summary-times", `${clock(choice.depart)} – ${clock(choice.arrive)}`));
  sheet.push(summary);

  if (trip.choices.length > 1) {
    const ride = choice.legs.find((l) => l.kind === "ride");
    sheet.push(choicesSection(ride, trip.choices, choice.exit.position, (picked) => {
      state.choice = trip.choices.indexOf(picked);
      renderPreview();
    }));
  }

  sheet.push(legList(choice.legs, -1));
  const start = el("button", "primary wide", "Start trip");
  start.type = "button";
  start.addEventListener("click", startLive);
  sheet.push(start);
  els.sheet.replaceChildren(...sheet);
}

// "Where to get off the 4": one selectable card per exit
function choicesSection(ride, choices, chosenPosition, onPick) {
  const wrap = el("div", "choices");
  const title = el("div", "section-title");
  title.append("Where to get off the", routeBadge(ride.route, true));
  wrap.append(title);

  const fastest = Math.min(...choices.map((c) => c.arrive.getTime()));
  for (const choice of choices) {
    const card = el("button", "choice");
    card.type = "button";
    if (choice.exit.position === chosenPosition) card.classList.add("selected");
    card.setAttribute("aria-pressed", String(choice.exit.position === chosenPosition));

    const middle = el("div");
    middle.append(el("div", "choice-stop", choice.exit.name));
    const then = el("div", "choice-then");
    then.append("then", ...continuationChips(choice, true));
    middle.append(then);

    const time = el("div", "choice-time", clock(choice.arrive));
    const later = Math.round((choice.arrive.getTime() - fastest) / 60000);
    if (later <= 0) time.append(el("small", null, "fastest"));
    else time.append(el("small", null, `+${later} min`));

    card.append(el("span", "choice-radio"), middle, time);
    card.addEventListener("click", () => onPick(choice));
    wrap.append(card);
  }
  return wrap;
}

function otherExits(choices, selected) {
  return choices
    .filter((c) => c !== selected)
    .map((c) => {
      const s = c.exit.stop;
      return { lat: state.net.lat[s], lon: state.net.lon[s], label: `${c.exit.name} → ${c.exit.then}` };
    });
}

// --- A trip: live -----------------------------------------------------------------------

function startLive() {
  const choice = state.trip.choices[state.choice];
  state.tracker = new TripTracker(state.net, choice, state.results.dest);
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
  state.liveTimer = setInterval(renderLive, LIVE_TICK_MS);
  keepScreenOn();
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
  els.alert.hidden = true;
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
      .map((c) => ({ lat: net.lat[c.exit.stop], lon: net.lon[c.exit.stop], label: `${c.exit.name} → ${c.exit.then}` }));
    state.map.show(net, remaining, { exits, fit: state.shownLeg !== tracker.legIndex });
    state.shownLeg = tracker.legIndex;
  }

  if (st.alert === "next") showAlert(`Next stop: ${st.leg.toStop.name}. Get ready to get off.`, [200, 100, 200]);
  if (st.alert === "now") showAlert(`Get off now at ${st.leg.toStop.name}`, [500, 200, 500, 200, 500]);

  const sheet = [];
  if (st.phase === "done") {
    const card = el("div", "now-card");
    card.append(el("div", "now-title", "You've arrived"), el("div", "now-detail", state.results.dest.name));
    sheet.push(card, button("primary wide", "Done", endTrip));
    els.sheet.replaceChildren(...sheet);
    return;
  }

  sheet.push(nowCard(st, now));

  if (st.choices && st.choices.length > 0) {
    sheet.push(
      choicesSection(st.leg, st.choices, st.chosenExit, (picked) => {
        tracker.chooseExit(picked);
        els.alert.hidden = true;
        renderLive();
      })
    );
  }

  if (state.pickingStop && st.leg.kind === "ride") sheet.push(stopPicker(st));
  sheet.push(legList(tracker.legs, tracker.legIndex));
  sheet.push(button("secondary wide", "End trip", endTrip));
  els.sheet.replaceChildren(...sheet);
}

// The big "what to do now" card
function nowCard(st, now) {
  const card = el("div", "now-card");
  const title = el("div", "now-title");
  const detail = el("div", "now-detail");
  const actions = el("div", "button-row");
  card.append(title, detail);

  if (st.phase === "walk") {
    const leg = st.leg;
    title.append(st.final ? "Walk to your destination" : `Walk to ${leg.to.name}`);
    const minutes = Math.max(1, Math.round(leg.seconds / 60));
    detail.textContent =
      st.metersLeft != null ? `About ${Math.round(st.metersLeft)} m to go` : `About ${minutes} min · ${Math.round(leg.meters)} m`;
    actions.append(
      st.final
        ? button("primary", "I've arrived", () => {
            state.tracker.arrivedAtStop();
            renderLive();
          })
        : button("primary", "I'm at the stop", () => {
            state.tracker.arrivedAtStop();
            renderLive();
          })
    );
  } else if (st.phase === "wait") {
    title.append(routeBadge(st.leg.route), `toward ${st.leg.headsign}`);
    detail.textContent =
      `At ${st.leg.fromStop.name}. Runs about every ${st.headwayMinutes} min` +
      (st.waitMinutes > 0 ? `, next in about ${st.waitMinutes} min.` : ".");
    card.append(el("div", "now-note", "Estimated from the schedule."));
    actions.append(button("primary", "I'm on board", () => {
      state.tracker.boardedNow(new Date());
      renderLive();
    }));
  } else {
    const exitName = st.leg.toStop.name;
    if (st.phase === "getoff") {
      card.classList.add("getoff");
      title.append(`Get off now: ${exitName}`);
      detail.textContent = `Then ${describeNext(state.tracker)}.`;
    } else {
      title.append(routeBadge(st.leg.route), st.nextStop ? `Next: ${st.nextStop}` : `toward ${st.leg.headsign}`);
      detail.textContent = `Get off at ${exitName} · ${st.stopsLeft} stop${st.stopsLeft === 1 ? "" : "s"} away`;
      const gpsQuiet = Date.now() - state.lastFixAt > NO_GPS_AFTER_MS;
      card.append(
        el(
          "div",
          "now-note",
          st.confirmed && !gpsQuiet
            ? "Position from GPS."
            : "No GPS here (underground?), so position is estimated from the schedule. Tap I'm here if it's off."
        )
      );
      actions.append(button("secondary", state.pickingStop ? "Close" : "I'm here…", () => {
        state.pickingStop = !state.pickingStop;
        renderLive();
      }));
    }
    actions.append(button("primary", "I got off", () => {
      state.tracker.gotOff();
      els.alert.hidden = true;
      renderLive();
    }));
  }
  card.append(actions);
  return card;
}

// "I'm here": the stops from here to the end of the line
function stopPicker(st) {
  const list = el("ul", "stop-picker");
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

function showAlert(text, pattern) {
  els.alert.textContent = text;
  els.alert.hidden = false;
  navigator.vibrate?.(pattern);
  clearTimeout(showAlert.timer);
  showAlert.timer = setTimeout(() => (els.alert.hidden = true), 12000);
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
      const stops = leg.to - leg.from;
      main.append(el("div", "leg-main", `toward ${leg.headsign}`));
      main.append(
        el(
          "div",
          "leg-detail",
          `Board at ${leg.fromStop.name} · ${clock(leg.board)} (every ~${Math.round((leg.wait * 2) / 60)} min)\n` +
            `Ride ${stops} stop${stops === 1 ? "" : "s"} · ${Math.round((leg.arrive - leg.board) / 60000)} min\n` +
            `Get off at ${leg.toStop.name} · ${clock(leg.arrive)}`
        )
      );
      main.lastChild.style.whiteSpace = "pre-line";
    }
    li.append(icon, main);
    list.append(li);
  });
  return list;
}

// Small icons for a trip's legs: 🚶 › 4 › Bx11 › 🚶
function legChips(legs) {
  const chips = [];
  legs.forEach((leg, i) => {
    if (i) chips.push(el("span", "sep", "›"));
    chips.push(leg.kind === "walk" ? walkIcon() : routeBadge(leg.route));
  });
  return chips;
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
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
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
  els.title.textContent = trip ? "Trip" : "Forkway";
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
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.tracker) {
      keepScreenOn();
      renderLive();
    }
  });
}

boot();
