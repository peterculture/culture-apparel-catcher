/* The Catch — tablet app for the catchers at the end of the screen-print dryers.
 *
 * Plain JavaScript, no build step. Everything the catcher sees comes from
 * /api/*, which talks to Salesforce. Nothing is ever shown as "saved" until
 * the server says Salesforce confirmed it.
 */
(function () {
  "use strict";

  var ZOOMS = [0.85, 1, 1.15, 1.3, 1.5, 1.75];
  /* Refresh and loading rules: copied from The Forge (handoff 2026-10-29). */
  var POLL_MS = { board: 15000, past: 30000 };   // In Production board: a main board (15 s). Past Orders: a side list (30 s).
  var ERROR_RETRY_EVERY = 5;                     // after a failed load, ask again only every 5th tick
  var CONFIG_ERRORS = ["org_not_configured", "sf_auth_failed"];   // retrying can't fix these: no Try Again button

  var state = {
    user: null,            // { name }
    reasons: [],
    boxTypes: [],
    orders: [],
    // Each list holds exactly ONE connection state, and that state alone decides what it shows,
    // whether it refreshes and whether it may save: loading -> live / stale / error.
    // (The Forge's "demo" state isn't used: The Catch has no sample data.)
    scr: { board: freshScreen(), past: freshScreen() },
    selId: null,
    view: "list",          // narrow screens show list OR detail
    zoom: readZoom(),
    sheet: null,           // "box" | "mis" | "mock" | "fin"
    box: null,             // { type, cells: { "line|size": "digits" }, sel: "line|size", requestId }
    mis: null,             // { line, size, qty, reason, note }
    saving: false,
    pending: null,         // last save, so "Try again" re-sends the SAME request id
    toast: null,           // { kind: ok|err|unsure, title, body, retry }
    pin: "",
    mode: "board",         // "board" (In Production) | "past" (Past Orders)
    q: "",                 // order search (number or customer); cleared when switching lists or signing out
    past: [], pastSelId: null,
    del: null,             // { boxId, requestId } while the Delete Box dialog is open
    logoutPending: null,   // a logout waiting for a save that's already on its way to Salesforce
    draft: null,           // an unsaved form kept for the SAME catcher after an automatic sign-out
    signoutMsg: "",
    help: null,            // { text, sending, sent, emailed, err } while the Help pop-up is open (11-02)
    picking: null,         // { orderId, ids: { boxId: true } } while SELECT is on under "Boxes on this order" (11-02)
    delMany: null,         // { ids: [boxId..], requestId } while the "delete N boxes" dialog is open
    sz: null,              // { line, vals: {size: "n"}, sel, fresh, note, requestId } while SIZES CHANGED is open (11-04)
    org: null,             // { key, label, switchable } -- which Salesforce this site is on (11-12)
    orgsw: null            // { envs, pick, pin, busy, err } while the org switcher is open (preview site only)
  };

  var $app = document.getElementById("app");
  var $overlay = document.getElementById("overlay");
  var $toast = document.getElementById("toast");
  var $help = document.getElementById("help");
  var $orgsw = document.getElementById("orgsw");
  var toastTimer = null;

  /* ------------------------------------------------------------ helpers -- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function readZoom() {
    try { var z = Number(localStorage.getItem("catchZoom")); return ZOOMS.indexOf(z) >= 0 ? z : 1; } catch (e) { return 1; }
  }
  function saveZoom(z) { try { localStorage.setItem("catchZoom", String(z)); } catch (e) {} }
  function newRequestId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function initials(name) {
    var p = String(name || "").replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/);
    return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
  }
  function firstName(name) { return String(name || "").split(" ")[0]; }
  function fmtDate(iso) {
    if (!iso) return "no print date";
    var d = new Date(iso); if (isNaN(d)) return "";
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var day = new Date(d); day.setHours(0, 0, 0, 0);
    var diff = Math.round((day - today) / 86400000);
    if (diff === 0) return "today";
    if (diff === -1) return "yesterday";
    if (diff === 1) return "tomorrow";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
  function fmtTime(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  /* The word the shop uses in box names: "Tees", "Hoodies", "Crewnecks"... (Garment Type = word + box number).
     Decided in this order (11-02: every box was coming out "Tees", because product names are mostly
     brand + style number, e.g. "Lane Seven LS16004", "Pennant 5483"):
       1. STYLE_WORDS: style numbers we know (Lane Seven, Anthony 11-02). Checked first, because
          Salesforce's Product Family can't tell a hoodie from a crew ("Sweatshirts" for both).
       2. A garment word in the product name ("HEAVY CREW", "Pullover Hooded"...).
       3. The product's Family in Salesforce ("Hoodies", "Long Sleeve", "T-Shirts"...).
       4. Otherwise "Tees". */
  var STYLE_WORDS = [
    // Lane Seven (Anthony 11-02: "make all the Lane Seven garments crewnecks"; LS14001 is the hoodie)
    [/\bLS14001(YH)?\b/i, "Hoodies"], [/\bLS16001\b/i, "Hoodies"], [/\bLS19001\b/i, "Hoodies"], [/^Lane Seven 17001\b/i, "Hoodies"],
    [/\bLS14004\b/i, "Crewnecks"], [/\bLS16004\b/i, "Crewnecks"],
    [/\bLS15001\b/i, "Tees"], [/\bLS16005\b/i, "Tees"], [/\bLST002\b/i, "Tees"],
    [/\bLS16006\b/i, "Joggers"]
  ];
  var FAMILY_WORDS = {
    "t-shirts": "Tees", "short sleeve": "Tees", "youth t-shirt": "Tees",
    "hoodies": "Hoodies", "sweatshirts": "Crewnecks", "sweatshirt": "Crewnecks", "fleece": "Fleece",
    "long sleeve": "Long Sleeves", "polo": "Polos", "hats": "Hats", "headwear": "Hats", "hd": "Hats",
    "headwear - winter": "Beanies", "outerwear": "Jackets", "zip up jackets": "Jackets", "bags": "Bags"
  };
  function shortFor(product, family) {
    var p = String(product || "");
    for (var i = 0; i < STYLE_WORDS.length; i++) if (STYLE_WORDS[i][0].test(p)) return STYLE_WORDS[i][1];
    if (/beanie/i.test(p)) return "Beanies";
    if (/\bhat\b|\bcap\b|trucker|snapback|richardson/i.test(p)) return "Hats";
    if (/hood/i.test(p)) return "Hoodies";
    if (/crew|sweat/i.test(p)) return "Crewnecks";
    if (/polo/i.test(p)) return "Polos";
    if (/tank/i.test(p)) return "Tanks";
    if (/long ?sleeve|\bl\/?s\b/i.test(p)) return "Long Sleeves";
    if (/tote|bag/i.test(p)) return "Bags";
    var f = FAMILY_WORDS[String(family || "").trim().toLowerCase()];
    if (f) return f;
    if (/fleece/i.test(p)) return "Fleece";
    return "Tees";
  }
  function lineWord(l) { return shortFor(l && l.product, l && l.family); }
  function findIn(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /** The order on screen: from the board, or from Past Orders. */
  function current() {
    return state.mode === "past" ? findIn(state.past, state.pastSelId) : findIn(state.orders, state.selId);
  }
  /* The 7-day review window. The SERVER decides (it re-checks every edit and delete on its own
     clock); this only hides buttons for boxes that are clearly past it. */
  var REVIEW_MS = 7 * 24 * 3600 * 1000;
  function withWindow(b) {
    if (!b.editableUntil && b.at) { b.editableUntil = new Date(Date.parse(b.at) + REVIEW_MS).toISOString(); b.editable = true; }
    return b;
  }
  function canChangeBox(b) { return !!b.editable && Date.now() < Date.parse(b.editableUntil || 0); }
  function fmtWhen(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function garmentWordOf(name) { return String(name || "").replace(/\s+\d+$/, "").trim() || "Box"; }
  var ICON = {
    swap: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg>',
    x: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>',
    box: '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>',
    warn: '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>',
    expand: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    tick: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    check: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    bang: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 6v8M12 18v.01"/></svg>',
    shirt: '<svg width="70%" height="70%" viewBox="0 0 48 48" aria-hidden="true"><path d="M17 8 L9 12 L5 20 L10 23 L13 19 L13 41 L35 41 L35 19 L38 23 L43 20 L39 12 L31 8 Q24 13 17 8 Z" fill="#2a2a30" stroke="#4a4a52" stroke-width="1.2"/></svg>'
  };

  /* ------------------------------------------------ connection states -- */
  function freshScreen() { return { s: "loading", at: 0, misses: 0, ticks: 0, err: "", config: false }; }
  /** The list on screen now: state.scr.board or state.scr.past. */
  function scrNow() { return state.scr[state.mode === "past" ? "past" : "board"]; }
  /** May this list refresh on this tick? live/stale: yes. error: every 5th tick. loading: no. */
  function shouldPoll(sc) {
    if (sc.s === "live" || sc.s === "stale") return true;
    if (sc.s !== "error") return false;
    sc.ticks = (sc.ticks || 0) + 1;
    return sc.ticks % ERROR_RETRY_EVERY === 0;
  }
  function isConfigError(data) { return !!(data && CONFIG_ERRORS.indexOf(data.error) >= 0); }
  /** true = ignore this ONE failure (the list stays as it is, still live). The second in a row counts. */
  function missOnce(sc, wasLive, data) {
    sc.misses = (sc.misses || 0) + 1;
    return wasLive && !isConfigError(data) && sc.misses < 2;
  }
  /** A good load: back to live, failure counter cleared, "N m old" counts from now. */
  function loadOk(sc) { sc.misses = 0; sc.ticks = 0; sc.s = "live"; sc.at = Date.now(); sc.err = ""; sc.config = false; }
  /** A failure that counts: stale when real rows are on screen (and retrying can help), else error. */
  function loadFailed(sc, data) {
    var hadRows = sc.s === "live" || sc.s === "stale";
    sc.err = (data && data.message) || "Salesforce didn't answer.";
    sc.config = isConfigError(data);
    sc.s = hadRows && !sc.config ? "stale" : "error";
  }
  function minutesOld(sc) { return Math.max(1, Math.ceil((Date.now() - sc.at) / 60000)); }

  /* -------------------------------------------- loading indicators ----- */
  // Two indicators, both hooked into the ONE place every request passes through
  // (trackRequest, used by api() and the mockup fetch), so no screen can be forgotten.
  //  1. Big centre loader -- opt-in, only for signing in and a list's first load
  //     (Past Orders the first time it's opened). Paints after 320 ms, gone after 15 s at most.
  //  2. Small corner icon -- every request, at once; stays at least 500 ms; a request
  //     older than 15 s turns it amber, "STILL CONNECTING…". It never blocks a tap.
  var LOADER_DELAY_MS = 320, LOADER_MAX_MS = 15000;
  var fgDepth = 0, fgInFlight = 0, showT = null, maxT = null;
  function loaderEl() { return document.getElementById("app-loader"); }
  function overlay(on) {
    try {
      var el = loaderEl();
      if (on && !el) {
        el = document.createElement("div");
        el.id = "app-loader"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
        el.innerHTML = '<div class="ld-box"><img class="ld-mark" src="/brand/catch-mark.png" alt="" width="124" height="96"><span class="ld-t">LOADING</span></div>';
        document.body.appendChild(el);
      } else if (!on && el) el.parentNode.removeChild(el);
    } catch (e) {}
  }
  function clearOverlayTimers() { clearTimeout(showT); clearTimeout(maxT); showT = maxT = null; }
  /** Requests started synchronously inside fn() get the big loader; anything after a .then stays silent. */
  function foregroundLoad(fn) { fgDepth++; try { return fn(); } finally { fgDepth--; } }
  function hideLoader() { fgInFlight = 0; clearOverlayTimers(); overlay(false); }
  function loaderTimeout() { console.warn("[catch] big loader hidden after 15 s; a request is still waiting"); overlay(false); }
  window.addEventListener("pageshow", function (e) { if (e.persisted) hideLoader(); });   // back button ONLY (pageshow also fires on every normal load)

  var BUSY_MIN_MS = 500, BUSY_SLOW_MS = 15000;
  var busySeq = 0, busyN = 0, busyShownAt = 0, busyHideT = null, busyTick = null, busyReqs = {};
  function badge(on) {
    var el = document.getElementById("app-busy");
    if (on && !el) {
      el = document.createElement("div");
      el.id = "app-busy"; el.setAttribute("role", "status");
      var hdr = document.querySelector("header");
      el.style.top = (hdr ? Math.round(hdr.getBoundingClientRect().bottom) + 8 : 12) + "px";
      el.innerHTML = '<span class="busy-ring"><img src="/brand/catch-mark.png" alt=""></span><span class="busy-t">LOADING</span>';
      document.body.appendChild(el);
      busyShownAt = Date.now();
      busyTick = setInterval(function () {
        try {
          var now = Date.now(), slow = Object.keys(busyReqs).some(function (k) { return now - busyReqs[k] >= BUSY_SLOW_MS; });
          el.classList.toggle("slow", slow);
          el.querySelector(".busy-t").textContent = slow ? "STILL CONNECTING…" : "LOADING";
        } catch (e) {}
      }, 1000);
    } else if (!on && el) { el.parentNode.removeChild(el); clearInterval(busyTick); busyTick = null; }
  }
  function busyBegin() {
    var id = ++busySeq;
    try { busyReqs[id] = Date.now(); busyN++; clearTimeout(busyHideT); busyHideT = null; badge(true); } catch (e) {}
    return id;
  }
  function busyEnd(id) {
    try {
      if (!(id in busyReqs)) return;
      delete busyReqs[id]; busyN = Math.max(0, busyN - 1);
      if (busyN) return;
      var wait = BUSY_MIN_MS - (Date.now() - busyShownAt);
      if (wait > 0) busyHideT = setTimeout(function () { if (!busyN) badge(false); }, wait); else badge(false);
    } catch (e) {}
  }
  /** The one hook every request goes through. */
  function trackRequest(promise) {
    var fg = fgDepth > 0;
    if (fg && ++fgInFlight === 1 && !showT && !loaderEl()) {
      showT = setTimeout(function () {
        showT = null; overlay(true);
        maxT = setTimeout(loaderTimeout, LOADER_MAX_MS);
      }, LOADER_DELAY_MS);
    }
    var ticket = busyBegin();
    var done = function () {
      busyEnd(ticket);
      // The hide waits one moment, so a sign-in followed straight away by the order list
      // reads as ONE loader instead of two flashes.
      if (fg && --fgInFlight <= 0) setTimeout(function () { if (fgInFlight <= 0) hideLoader(); }, 0);
    };
    return promise.then(function (v) { done(); return v; }, function (e) { done(); throw e; });
  }

  /* ---------------------------------------------------------------- api -- */
  function api(method, path, body) {
    var write = method !== "GET";
    var ctrl = window.AbortController ? new AbortController() : null;
    // Longer than the server's own limits (Salesforce reads 30 s, sign-in 8 s + one retry), so the
    // server's answer -- with Salesforce's own words -- arrives before the tablet gives up.
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, write ? 45000 : 45000) : null;
    return trackRequest(fetch(path, {
      method: method,
      credentials: "same-origin",
      // A save says which org the screen was showing; the server refuses it if the site switched since (11-12).
      headers: Object.assign(body ? { "Content-Type": "application/json" } : {}, write && state.org && state.org.key ? { "X-Catch-Org": state.org.key } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      cache: "no-store"
    }).then(function (resp) {
      clearTimeout(timer);
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (resp.status === 401 && path !== "/api/login") signedOut();
        return { ok: resp.ok, status: resp.status, data: data || {} };
      });
    }, function () {
      clearTimeout(timer);
      // No answer at all. For a save we can't know whether Salesforce got it.
      return { ok: false, status: 0, data: { error: write ? "unconfirmed" : "offline",
        message: write ? "The connection dropped before Salesforce answered, so we can't tell if this saved. Check the order before trying again."
                       : "No connection. Check the tablet's Wi-Fi." } };
    }));
  }

  /** Header dot + words, from the connection state of the list on screen. */
  function paintConn() {
    var dot = document.getElementById("conn-dot"), label = document.getElementById("conn-label");
    var sc = state.user ? scrNow() : null, k = sc ? sc.s : "loading";
    dot.className = k === "live" ? "live" : (k === "stale" || k === "error") ? "down" : "";
    label.textContent = k === "live" ? "Live · " + (isTestOrg() ? state.org.label : "Salesforce") : k === "stale" ? "Offline · " + minutesOld(sc) + " m old" : k === "error" ? "Not connected" : "Connecting";
  }

  /* ------------------------------------------------------------ sign-in -- */
  // No timed sign-out (Anthony 2026-10-16): a catcher stays signed in until they tap their
  // name to log out, or the app is refreshed (every page load starts signed out).
  function hasUnsaved() {
    var o = current(); if (!o) return false;
    if (state.sheet === "box" && state.box) return boxTotal(o, state.box) > 0;
    if (state.sheet === "mis" && state.mis) return !!(state.mis.size || state.mis.reason || state.mis.note);
    if (state.sheet === "dup" && state.dup) return true;
    return false;
  }
  function afterSave() {
    if (!state.user) { state.logoutPending = null; return; }
    if (state.logoutPending && !state.saving) { var why = state.logoutPending; state.logoutPending = null; doLogout(why); }
  }

  /** End the sign-in for real (server + tablet) and clear everything that belonged to that catcher. */
  function doLogout(reason) {
    releaseAwake();
    var who = state.user ? state.user.name : "";
    var o = current();
    // An unfinished form is kept ONLY for the same catcher, so their entries aren't lost --
    // and it's never handed to the next person (it would be credited to the wrong catcher).
    if (who && o && hasUnsaved() && reason !== "manual") {
      state.draft = { user: who, sheet: state.sheet, mode: state.mode, orderId: o.id, num: o.num,
        box: state.box ? JSON.parse(JSON.stringify(state.box)) : null,
        mis: state.mis ? JSON.parse(JSON.stringify(state.mis)) : null,
        dup: state.dup ? JSON.parse(JSON.stringify(state.dup)) : null };
    } else if (reason === "manual") {
      state.draft = null;
    }
    api("POST", "/api/logout");
    state.user = null; state.logoutPending = null; state.q = "";
    state.orders = []; state.selId = null; state.past = []; state.pastSelId = null;
    state.scr = { board: freshScreen(), past: freshScreen() };
    state.sheet = null; state.box = null; state.mis = null; state.dup = null; state.del = null; state.fin = null; state.picking = null; state.delMany = null; state.sz = null;
    state.pending = null; state.saving = false; state.pin = ""; state.pinErr = ""; state.mode = "board"; state.view = "list";
    clearTimeout(toastTimer); state.toast = null; state.help = null; helpDraft = ""; state.orgsw = null; renderOrgSw();
    state.signoutMsg = reason === "expired" ? "Your sign-in ended." : "";
    if (state.draft) state.signoutMsg += " " + state.draft.user + "'s unsaved entries on " + state.draft.num + " are kept and reopen when " + firstName(state.draft.user) + " signs in again.";
    $overlay.removeAttribute("data-shown");
    hideLoader();
    renderAll(); paintConn();
  }

  /** After sign-in: give a catcher back the form they hadn't saved -- only if it's the same catcher. */
  function restoreDraft() {
    var d = state.draft; state.draft = null;
    if (!d || !state.user || d.user !== state.user.name) return;
    state.mode = d.mode;
    var list = d.mode === "past" ? state.past : state.orders;
    if (!findIn(list, d.orderId)) { showToast({ kind: "err", title: "COULDN'T REOPEN YOUR ENTRIES", body: d.num + " isn't on this list any more. Nothing was saved from before." }); renderMain(); return; }
    if (d.mode === "past") state.pastSelId = d.orderId; else state.selId = d.orderId;
    state.box = d.box; state.mis = d.mis; state.dup = d.dup; state.sheet = d.sheet; state.view = "detail";
    renderMain(); renderOverlay();
    showToast({ kind: "ok", title: "YOUR ENTRIES ARE BACK", body: "Nothing was saved yet on " + d.num + ". Check them and save." });
  }

  function signedOut() {
    // The server says this sign-in is over (401). Any save it answered is finished, so sign out now.
    state.saving = false;
    if (state.user) doLogout("expired");
  }

  /* --------------------------------------------------------------- load -- */
  /* One load function per list. The first load runs inside foregroundLoad() (big loader);
     the timer's refreshes are plain calls (corner icon only). A failure goes through
     missOnce(): the first one on a live list changes nothing; the second shows Offline. */
  function loadList(key) {
    if (!state.user) return Promise.resolve();
    var sc = state.scr[key], wasLive = sc.s === "live";
    return api("GET", key === "past" ? "/api/past-orders" : "/api/orders").then(function (r) {
      if (!state.user || r.status === 401) return;
      // The preview site was switched to another org (by another tablet): start over on the new one.
      if (r.ok && r.data.org && state.org && r.data.org !== state.org.key) { orgChanged(r.data.org, r.data.orgLabel, true); return; }
      if (r.ok && Array.isArray(r.data.orders)) {
        if (key === "past") {
          state.past = r.data.orders;
          if (!findIn(state.past, state.pastSelId)) state.pastSelId = state.past.length ? state.past[0].id : null;
        } else {
          state.orders = r.data.orders;
          if (!findIn(state.orders, state.selId)) state.selId = state.orders.length ? state.orders[0].id : null;
          dropOldMocks();
        }
        loadOk(sc);
      } else {
        if (missOnce(sc, wasLive, r.data)) {
          console.warn("[catch] one refresh of " + key + " failed; keeping what's on screen", r.status, r.data && r.data.error);
          return;
        }
        loadFailed(sc, r.data);
      }
      paintConn();
      if (!state.sheet && (key === "past") === (state.mode === "past")) renderMain();
    });
  }
  function loadOrders() { return loadList("board"); }
  /** Past Orders: boxed orders from the last 30 days, read fresh from Salesforce. */
  function loadPast() { return loadList("past"); }
  function reloadAll() { loadOrders(); loadPast(); }

  /* ------------------------------------------------------ keep awake ---- */
  // While a catcher is signed in, ask the browser to keep the screen on so the tablet
  // doesn't dim or lock between orders. The browser drops the lock whenever the app is
  // hidden (tablet slept, other app), so it is asked for again when the app comes back.
  // Older browsers without wake lock just behave as before.
  var wakeLock = null;
  function keepAwake() {
    if (!state.user || document.hidden || wakeLock || !navigator.wakeLock) return;
    navigator.wakeLock.request("screen").then(function (l) {
      wakeLock = l;
      l.addEventListener("release", function () { if (wakeLock === l) wakeLock = null; });
      if (!state.user) releaseAwake();          // signed out while the request was on its way
    }).catch(function () {});
  }
  function releaseAwake() {
    var l = wakeLock; wakeLock = null;
    if (l) l.release().catch(function () {});
  }

  function loadSetup() {
    return Promise.all([api("GET", "/api/me"), api("GET", "/api/box-types")]).then(function (rs) {
      if (rs[0].ok) { state.user = { name: rs[0].data.name }; state.reasons = rs[0].data.reasons || []; keepAwake();
        if (rs[0].data.org) { state.org = rs[0].data.org; paintOrg(); } }
      if (rs[1].ok) state.boxTypes = rs[1].data.types || [];
    });
  }

  /* ------------------------------------------------------------ zoom ----- */
  function applyZoom() {
    document.documentElement.style.setProperty("--z", state.zoom);
    document.getElementById("zoom-reset").textContent = Math.round(state.zoom * 100) + "%";
    var i = ZOOMS.indexOf(state.zoom);
    document.getElementById("zoom-out").disabled = i <= 0;
    document.getElementById("zoom-in").disabled = i >= ZOOMS.length - 1;
    var narrow = window.innerWidth / state.zoom < 980;
    document.body.classList.toggle("narrow", narrow);
    document.body.classList.toggle("view-list", narrow && state.view === "list");
    document.body.classList.toggle("view-detail", narrow && state.view !== "list");
  }
  function stepZoom(dir) {
    var i = ZOOMS.indexOf(state.zoom) + dir;
    if (i < 0 || i >= ZOOMS.length) return;
    state.zoom = ZOOMS[i]; saveZoom(state.zoom); applyZoom();
  }

  /* ------------------------------------------------------------ render --- */
  function renderAll() {
    var who = document.getElementById("who");
    if (state.user) {
      who.hidden = false;
      document.getElementById("who-init").textContent = initials(state.user.name);
      document.getElementById("who-name").textContent = state.user.name;
    } else {
      who.hidden = true;
    }
    document.getElementById("help-btn").hidden = !state.user;
    renderMain(); renderOverlay(); renderHelp(); renderToast(); applyZoom();
  }

  function renderMain() {
    if (!state.user) { $app.innerHTML = pinHtml(); return; }
    // While someone is typing in the search box, a background refresh waits until they leave the
    // box, so the keyboard doesn't close mid-word. (Tapping anything else leaves the box first.)
    var a = document.activeElement;
    if (a && a.id === "order-search") { renderPending = true; return; }
    renderPending = false;
    // A refresh redraws the screen; keep where the catcher had scrolled to (the card list,
    // and the order panel when it's still the same order), so nothing jumps back to the top.
    var o = current(), sig = state.mode + ":" + (o ? o.id : "");
    var cards = $app.querySelector(".cards"), det = $app.querySelector(".detail");
    var keepCards = cards && lastMainMode === state.mode ? cards.scrollTop : 0;
    var keepDet = det && lastMainSig === sig ? det.scrollTop : 0;
    $app.innerHTML = listHtml() + detailHtml();
    lastMainMode = state.mode; lastMainSig = sig;
    if (keepCards && (cards = $app.querySelector(".cards"))) cards.scrollTop = keepCards;
    if (keepDet && (det = $app.querySelector(".detail"))) det.scrollTop = keepDet;
    applySearch();
    wireImages();
    applyZoom();
  }

  /* ------------------------------------------------------------ search --- */
  var renderPending = false, lastMainMode = "", lastMainSig = "";
  function searchKey(o) {
    var num = String(o.num || "");
    return (num + " " + num.replace(/[^a-z0-9]/gi, "") + " " + (o.customer || "")).toLowerCase();
  }
  function searchBoxHtml() {
    return '<div class="search"><input id="order-search" type="search" enterkeyhint="done" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ' +
      'placeholder="Search order # or customer" aria-label="Search orders by number or customer" value="' + esc(state.q) + '">' +
      '<button class="search-x" data-act="search-clear" aria-label="Clear search"' + (state.q ? "" : " hidden") + ">" + ICON.x + "</button></div>" +
      '<div class="empty search-none" id="search-none" hidden></div>';
  }
  /** Show only the cards that match the search, without rebuilding the list. */
  function applySearch() {
    var words = state.q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    var shown = 0, total = 0;
    Array.prototype.forEach.call($app.querySelectorAll(".card[data-q]"), function (c) {
      total++;
      var k = c.getAttribute("data-q"), hit = words.every(function (w) { return k.indexOf(w) >= 0; });
      c.hidden = !hit; if (hit) shown++;
    });
    var none = document.getElementById("search-none");
    if (none) { none.hidden = !(total && !shown); none.innerHTML = "<strong>NO MATCH</strong>Nothing on this list matches “" + esc(state.q) + "”."; }
    var x = $app.querySelector(".search-x"); if (x) x.hidden = !state.q;
  }

  /* ----------------------------------------------------------- mockups --- */
  // Each order's mockup is fetched ONCE and turned into one picture that the small
  // card, the big picture and the zoom viewer all share. JPG/PNG are used as they
  // are. PDFs -- and Illustrator (.ai) files, which carry a PDF copy inside -- are
  // drawn into a picture right here on the tablet by pdf.js (kept in /vendor, so
  // nothing is loaded from outside servers).
  var mocks = {};                 // orderId -> { url, failed, at, promise }
  var pdfLib = null, pdfQueue = Promise.resolve();
  var MOCK_PX = 2000;             // longest side of a drawn PDF: sharp when zoomed, light on memory

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function loadPdfJs() {
    if (pdfLib) return pdfLib;
    pdfLib = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/vendor/pdf.min.js";
      s.onload = function () {
        var lib = window.pdfjsLib;
        if (!lib) { pdfLib = null; return reject(new Error("pdf.js missing")); }
        lib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";
        resolve(lib);
      };
      s.onerror = function () { pdfLib = null; reject(new Error("pdf.js did not load")); };
      document.head.appendChild(s);
    });
    return pdfLib;
  }

  /** First page of a PDF -> a JPEG picture (Blob). One at a time: artwork files are heavy for a tablet. */
  function pdfToPicture(buf) {
    var job = pdfQueue.then(function () {
      return loadPdfJs().then(function (lib) {
        return lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
      }).then(function (doc) {
        var done = function (v) { try { doc.destroy(); } catch (e) {} return v; };
        return doc.getPage(1).then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var vp = page.getViewport({ scale: Math.min(6, MOCK_PX / Math.max(base.width, base.height)) });
          var canvas = document.createElement("canvas");
          canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
          return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
            return new Promise(function (resolve, reject) {
              canvas.toBlob(function (blob) {
                canvas.width = canvas.height = 0;  // give the memory back straight away
                if (blob) resolve(blob); else reject(new Error("could not make a picture"));
              }, "image/jpeg", 0.9);
            });
          });
        }).then(done, function (err) { done(); throw err; });
      });
    });
    pdfQueue = job.catch(function () {});
    return job;
  }

  /** Resolves to a picture Blob, null when the order has no mockup; rejects when it failed. */
  /** key = "orderId:n" (n = which picture, 0 = newest). */
  function fetchMock(key) {
    var parts = key.split(":");
    // The download goes through trackRequest() like every other request (corner icon);
    // drawing a PDF afterwards is the tablet's own work, so it's outside it.
    return trackRequest(fetch("/api/mockup?orderId=" + encodeURIComponent(parts[0]) + "&n=" + (parseInt(parts[1], 10) || 0), { credentials: "same-origin" }).then(function (resp) {
      if (resp.status === 401) { signedOut(); return null; }
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error("mockup " + resp.status);
      var type = (resp.headers.get("Content-Type") || "").split(";")[0].trim();
      return resp.arrayBuffer().then(function (buf) { return { type: type, buf: buf }; });
    })).then(function (got) {
      if (!got) return null;
      if (/^image\//.test(got.type)) return new Blob([got.buf], { type: got.type });
      if (got.type === "application/pdf") return pdfToPicture(got.buf);
      throw new Error("mockup type " + got.type);
    });
  }

  function getMock(id) {
    var m = mocks[id];
    if (m && m.url) return Promise.resolve(m.url);
    if (m && m.promise) return m.promise;
    if (m && m.failed && Date.now() - m.at < 60000) return Promise.resolve(null);  // try again after a minute
    m = mocks[id] = { url: null, failed: false, at: Date.now(), promise: null };
    // A failure gets one more try a moment later (the server may still be fetching it from Salesforce).
    m.promise = fetchMock(id).catch(function () { return wait(2500).then(function () { return fetchMock(id); }); })
      .then(function (blob) {
        m.promise = null;
        if (!blob) { m.failed = true; m.at = Date.now(); return null; }
        m.url = URL.createObjectURL(blob);
        return m.url;
      }, function () { m.promise = null; m.failed = true; m.at = Date.now(); return null; });
    return m.promise;
  }

  /** Free pictures of orders that have left the list. */
  function dropOldMocks() {
    var keep = {};
    state.orders.forEach(function (o) { keep[o.id] = 1; });
    Object.keys(mocks).forEach(function (id) {
      if (!keep[id.split(":")[0]]) { if (mocks[id].url) URL.revokeObjectURL(mocks[id].url); delete mocks[id]; }
    });
  }

  function showMock(img, url) {
    if (url) { img.src = url; img.classList.add("ready"); return; }
    var box = img.parentNode;
    if (!box) return;
    if (img.classList.contains("thumb-img")) { box.innerHTML = ICON.shirt; return; }
    if (img.id === "v-img") { box.innerHTML = '<span class="mock-none">THE MOCKUP FILE<br>CAN\'T BE SHOWN</span>'; return; }
    // The big picture: no longer tappable, and says why.
    box.removeAttribute("data-act");
    box.setAttribute("aria-label", "Mockup can't be shown");
    box.innerHTML = '<span class="mock-none">MOCKUP FILE<br>CAN\'T BE SHOWN</span>';
  }

  /** Fill every mockup <img data-mock="orderId"> inside root. */
  function fillMockups(root) {
    Array.prototype.forEach.call(root.querySelectorAll("img[data-mock]"), function (img) {
      var id = img.getAttribute("data-mock");
      if (mocks[id] && mocks[id].url) { showMock(img, mocks[id].url); return; }
      getMock(id).then(function (url) {
        // The screen may have been redrawn while waiting, so fill whatever shows this order now.
        Array.prototype.forEach.call(document.querySelectorAll('img[data-mock="' + id + '"]:not(.ready)'), function (el) {
          if (el.isConnected) showMock(el, url);
        });
      });
    });
  }

  function wireImages() { fillMockups($app); }

  function pinHtml() {
    var dots = "";
    for (var i = 0; i < 4; i++) dots += '<i class="' + (i < state.pin.length ? "on" : "") + '"></i>';
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"].map(function (k) {
      var label = k === "<" ? "⌫" : k === "C" ? "CLEAR" : k;
      var aria = k === "<" ? "Delete last digit" : k === "C" ? "Clear" : k;
      return '<button data-act="pin" data-k="' + k + '" class="' + (k === "<" || k === "C" ? "k2" : "") + '" aria-label="' + aria + '">' + label + "</button>";
    }).join("");
    return '<div class="pin-wrap ca-season-pin"><div class="pin-box">' +
      '<img class="pin-logo" src="/brand/catch-logo.png" alt="The Catch · Culture Apparel" width="623" height="636">' + seasonChip(false) +
      (isTestOrg() ? '<div class="pin-org">PREVIEW · ' + esc(String(state.org.label).toUpperCase()) + " · TEST DATA, NOT THE SHOP FLOOR</div>" : "") +
      "<h1>WHO'S CATCHING?</h1><p>Enter your 4-digit PIN</p>" +
      (state.signoutMsg ? '<div class="pin-note">' + esc(state.signoutMsg) + "</div>" : "") +
      '<div class="dots" id="dots">' + dots + "</div>" +
      '<div class="pin-err" id="pin-err">' + esc(state.pinErr || "") + "</div>" +
      '<div class="pin-pad">' + keys + "</div></div></div>";
  }

  /** Rows on screen? Only a live or stale list shows its rows and counts (never while loading or after an error). */
  function showsRows(sc) { return sc.s === "live" || sc.s === "stale"; }
  /** A failed load: nothing about the work, just the reason. Try Again only when retrying can help. */
  function errorBody(sc, title) {
    return '<div class="empty"><strong>' + title + "</strong>" + esc(sc.err) +
      (sc.config ? "" : '<br><button class="back" data-act="reload">TRY AGAIN</button>') + "</div>";
  }
  /** Last good rows kept on screen while Salesforce can't be reached. */
  function staleBanner(sc) {
    return '<div class="empty offline" role="status"><strong>OFFLINE · ' + minutesOld(sc) + " M OLD</strong>" +
      "Showing the list from " + esc(fmtTime(new Date(sc.at).toISOString())) + ". Saving is paused until Salesforce answers again; the app keeps trying on its own." +
      (sc.err ? '<span class="why">' + esc(sc.err) + "</span>" : "") + "</div>";
  }

  function modeTabs() {
    var n = showsRows(state.scr.board) ? "<span>" + state.orders.length + "</span>" : "";
    return '<div class="mode-tabs" role="tablist">' +
      '<button role="tab" data-act="mode" data-m="board" aria-selected="' + (state.mode === "board") + '">IN PRODUCTION ' + n + "</button>" +
      '<button role="tab" data-act="mode" data-m="past" aria-selected="' + (state.mode === "past") + '">PAST ORDERS</button></div>';
  }

  function pastListHtml() {
    var cards = state.past.map(function (o) {
      var open = o.boxes.filter(canChangeBox).length;
      var tag = open ? '<span class="tag edit">' + open + (open === 1 ? " BOX" : " BOXES") + " EDITABLE</span>" : '<span class="tag lock">READ-ONLY · PAST 7 DAYS</span>';
      return '<button class="card" data-act="pick" data-id="' + esc(o.id) + '" data-q="' + esc(searchKey(o)) + '" aria-pressed="' + (o.id === state.pastSelId) + '">' +
        '<span class="thumb">' + ICON.box + "</span>" +
        '<span class="card-body"><span class="card-num">' + esc(o.num) + (o.lines.some(function (l) { return l.changed; }) ? '<span class="sz-tag small">SIZES CHANGED</span>' : "") + "</span>" +
        '<span class="card-cust">' + esc(o.customer) + "</span>" + deliveryBadge(o) +
        '<span class="card-meta">' + o.boxes.length + (o.boxes.length === 1 ? " box" : " boxes") + (o.lastBoxAt ? " · last box " + esc(fmtDate(o.lastBoxAt)) + " " + esc(fmtTime(o.lastBoxAt)) : "") + "</span>" + tag + "</span></button>";
    }).join("");
    var body, sc = state.scr.past, rows = showsRows(sc);
    if (sc.s === "error") body = errorBody(sc, "COULDN'T LOAD PAST ORDERS");
    else if (!rows) body = '<div class="empty">Loading past orders…</div>';
    else body = (sc.s === "stale" ? staleBanner(sc) : "") + (state.past.length ? '<div class="cards">' + cards + "</div>"
      : sc.s === "stale" ? "" : '<div class="empty"><strong>NO BOXES IN THE LAST 30 DAYS</strong>Screen-print orders show here once boxes are logged on them.</div>');
    return '<section class="list" aria-label="Past orders">' + modeTabs() +
      '<div class="list-head ca-season-head"><div class="list-title"><h1>PAST ORDERS</h1>' + (rows ? '<span class="list-count">' + state.past.length + "</span>" : "") + "</div>" +
      '<div class="list-sub"><i></i>BOXES FROM THE LAST 30 DAYS · EDIT OR DELETE FOR 7 DAYS</div>' + seasonChip(true) + "</div>" + (rows && state.past.length ? searchBoxHtml() : "") + body + "</section>";
  }

  /** Order card progress: garments boxed so far against the order's total, with a bar. */
  function progressHtml(o) {
    if (isFulfillment(o)) return '<span class="card-meta">Fulfillment order. No boxes.</span>';
    var split = boxedSplit(o), boxed = split.ordered;   // extras ("Add More") don't count against the order
    var nBox = o.boxes.length + (o.boxes.length === 1 ? " box" : " boxes");
    if (!(o.total > 0)) return '<span class="card-meta">' + split.all + " boxed · " + nBox + "</span>";
    var pct = Math.round(boxed / o.total * 100);
    var state = boxed > o.total ? " over" : boxed === o.total ? " full" : "";
    return '<span class="card-meta"><b>' + boxed + "</b> of " + o.total + " boxed" + extraNote(split.extra) + " · " + nBox + "</span>" +
      '<span class="prog' + state + '" role="img" aria-label="' + pct + ' percent boxed"><i style="width:' + Math.min(100, pct) + '%"></i></span>';
  }

  function listHtml() {
    if (state.mode === "past") return pastListHtml();
    var cards = state.orders.map(function (o) {
      var sel = o.id === state.selId;
      var thumb = o.hasMockup ? '<img class="thumb-img" alt="" data-mock="' + esc(o.id) + ':0"><span class="mock-wait">' + ICON.shirt + "</span>" : ICON.shirt;
      var tag = !o.inProduction ? '<span class="tag moved">MOVED ON · FINISH COUNT</span>'
        : isFulfillment(o) ? '<span class="tag done">✓ FULFILLMENT · NO BOXES</span>'
        : o.finished ? '<span class="tag done">✓ COUNTED · ' + o.finishedCount + (o.finishedCount === 1 ? " BOX" : " BOXES") + "</span>" : "";
      return '<button class="card' + (o.inProduction ? "" : " moved") + '" data-act="pick" data-id="' + esc(o.id) + '" data-q="' + esc(searchKey(o)) + '" aria-pressed="' + sel + '">' +
        '<span class="thumb">' + thumb + "</span>" +
        '<span class="card-body"><span class="card-num">' + esc(o.num) + (o.lines.some(function (l) { return l.changed; }) ? '<span class="sz-tag small">SIZES CHANGED</span>' : "") + "</span>" +
        '<span class="card-cust">' + esc(o.customer) + "</span>" + deliveryBadge(o) +
        progressHtml(o) + tag + "</span></button>";
    }).join("");
    var body, sc = state.scr.board, rows = showsRows(sc);
    if (sc.s === "error") {
      body = errorBody(sc, "COULDN'T LOAD ORDERS");
    } else if (!rows) {
      body = '<div class="empty">Loading orders…</div>';
    } else if (!state.orders.length) {
      body = sc.s === "stale" ? staleBanner(sc)
        : '<div class="empty"><strong>NOTHING IN PRODUCTION</strong>No screen-print orders are marked In Production right now. This list refreshes on its own.</div>';
    } else {
      body = (sc.s === "stale" ? staleBanner(sc) : "") + '<div class="cards">' + cards + "</div>";
    }
    return '<section class="list" aria-label="Orders in production">' + modeTabs() +
      '<div class="list-head ca-season-head"><div class="list-title"><h1>IN PRODUCTION</h1>' + (rows ? '<span class="list-count">' + state.orders.length + "</span>" : "") + "</div>" +
      '<div class="list-sub"><i></i>SCREEN PRINT ONLY</div>' + seasonChip(true) + "</div>" + (rows && state.orders.length ? searchBoxHtml() : "") + body + "</section>";
  }

  /* Seasonal / holiday theme -- the production dashboard's own seasonal.js + photos
     (seasons/), shared unchanged so both apps always show the same theme. The words
     come from CSS (content: var(--ca-season-*)), so nothing here depends on the
     script: if it or the photo is missing, these stay hidden and nothing else changes. */
  function seasonChip(withFx) {
    return '<div class="season-chip"><span class="ca-season-dot"></span><span class="ca-season-name"></span>' +
      '<span class="season-sep">·</span><span class="ca-season-range"></span>' +
      (withFx ? '<button type="button" data-ca-fx-toggle="" class="ca-season-fxbtn season-fx" title="Turn the seasonal animation on or off on this tablet"></button>' : "") + "</div>";
  }

  function detailHtml() {
    var o = current(), sc = scrNow();
    if (!showsRows(sc)) return '<main class="detail"></main>';   // loading or failed: nothing about the work
    if (!o) return '<main class="detail"><div class="empty">Pick an order on the left.</div></main>';
    if (state.mode === "past") return pastDetailHtml(o);
    var split = boxedSplit(o), boxed = split.ordered;
    var mock = o.hasMockup
      ? '<button class="mock" data-act="mock" data-id="' + esc(o.id) + '" aria-label="Open the mockup full size"><img class="mock-img" alt="Mockup for ' + esc(o.num) + '" data-mock="' + esc(o.id) + ':0"><span class="mock-wait mock-none">LOADING<br>MOCKUP…</span><span class="badge">' + ICON.expand + '</span><span class="cap">' + ((o.mockupCount || 1) > 1 ? "TAP TO SEE ALL " + o.mockupCount : "TAP TO ENLARGE") + '</span></button>'
      : '<div class="mock"><span class="mock-none">NO MOCKUP<br>IN SALESFORCE</span></div>';
    var canSz = o.sizeChangesText != null;   // the Size Changes field is set up and readable
    var lines = o.lines.map(function (l, li) {
      var szHead = l.changed ? '<span class="sz-tag">' + (l.changed.waiting ? "WRONG SIZES · WAITING ON ACCOUNT MANAGER" : "SIZES CHANGED") + "</span>"
        : canSz && l.sizes.length ? '<button class="sz-btn" data-act="sz-open" data-i="' + li + '">' + ICON.swap + "SIZES CHANGED?</button>" : "";
      var szNote = l.changed ? '<div class="sz-note"><div class="sz-note-text"><span>' + (l.changed.note ? "“" + esc(l.changed.note) + "”" : "Sizes changed.") + "</span>" +
        "<small>" + esc(l.changed.by) + " · " + esc(l.changed.date) + "</small></div>" +
        (canSz ? '<button class="log-btn" data-act="sz-open" data-i="' + li + '">EDIT</button>' : "") + "</div>" : "";
      return '<div><div class="line-head"><span class="line-name">' + esc(l.product) + (l.color ? " · " + esc(l.color) : "") + "</span>" + szHead + '<span class="tot">' + l.total + "</span></div>" +
        '<div class="sizes">' + l.sizes.map(function (s) {
          // Misprinted / damaged so far on this size (stored on the order line; the Production Error screen starts from it).
          var bad = (s.misprinted || 0) + (s.damaged || 0);
          var chg = s.ordered != null && s.ordered !== s.qty;
          return '<div class="size' + (chg ? " chg" : "") + '"><div class="s">' + esc(s.size) + '</div><div class="q">' + s.qty + "</div>" +
            (chg ? '<div class="was"><s>' + s.ordered + "</s> ordered</div>" : "") +
            (bad ? '<div class="mp" title="' + (s.misprinted || 0) + " misprinted, " + (s.damaged || 0) + ' damaged">' + bad + " BAD</div>" : "") + "</div>";
        }).join("") + (l.extras || []).map(function (e) {
          return '<div class="size extra" title="Extra: not on the order"><div class="s">' + esc(e.size) + ' · EXTRA</div><div class="q">+' + e.boxed + "</div></div>";
        }).join("") + "</div>" + szNote + "</div>";
    }).join("");
    var log = boxRowsHtml(o, true);
    var misLog = o.misprintNotes ? '<div class="sec-label" style="margin-top:.6rem">MISPRINT NOTES IN SALESFORCE</div><div class="notes">' + esc(o.misprintNotes.split(" | ").join("\n")) + "</div>" : "";
    var banner = o.inProduction ? "" : '<div class="moved-banner">' + ICON.warn +
      "<div><b>MOVED TO " + esc(String(o.status || "Post-Production").toUpperCase()) + "</b>The print crew moved this order on. Finish logging its boxes, then tap FINISH CATCHING. It stays on your board until you do.</div></div>";
    return '<main class="detail">' +
      '<button class="back narrow-only" data-act="back">' + ICON.back + "ALL ORDERS</button>" + banner +
      '<div class="d-top">' + mock + '<div class="d-id"><h2 class="d-num">' + esc(o.num) + "</h2>" +
      '<div class="d-cust">' + esc(o.customer) + "</div>" + deliveryBadge(o, "dm-big") +
      '<div class="d-meta">Print date ' + esc(fmtDate(o.printDate)) + (o.specs ? " · " + esc(o.specs) : "") + "</div></div></div>" +
      '<div class="panel">' + (lines || '<div class="hint">No garment sizes on this order in Salesforce.</div>') + "</div>" +
      '<div class="stats"><div class="stat"><div class="l">BOXES</div><div class="v">' + o.boxes.length + "</div></div>" +
      '<div class="stat"><div class="l">BOXED</div><div class="v">' + boxed + " <small>/ " + o.total + (split.extra ? " · +" + split.extra + " extra" : "") + "</small></div></div>" +
      '<div class="stat"><div class="l">MISPRINTS</div><div class="v' + (o.misprintTotal ? " warn" : "") + '">' + o.misprintTotal + "</div></div></div>" +
      '<div class="actions"><button class="big big-red" data-act="open-box">' + ICON.box + "LOG BOXES</button>" +
      '<button class="big big-warn" data-act="open-mis">' + ICON.warn + "REPORT MISPRINT</button></div>" +
      finishBtn(o) +
      boxLogHtml(o, true, "BOXES ON THIS ORDER", log, "No boxes logged yet.", misLog) +
      "</main>";
  }

  /** Saved boxes, with Duplicate (board only), Edit and Delete -- or a lock once the 7 days are up. */
  function boxRowsHtml(o, onBoard) {
    var pk = pickingFor(o);
    return o.boxes.map(function (b, i) {
      withWindow(b);
      var open = canChangeBox(b);
      if (pk) {
        // SELECT mode: the whole row is the tick box; locked boxes can't be picked.
        var on = !!pk.ids[b.id];
        var info = '<span class="log-text"><span class="log-main">' +
          '<span class="kv"><span class="k">GARMENT TYPE</span>' + esc(b.name) + "</span>" +
          '<span class="kv"><span class="k">PACKAGING TYPE</span>' + esc(b.type || "—") + "</span>" +
          '<span class="kv"><span class="k">QUANTITY + SIZE COUNTED</span>' + esc(b.sizes || (b.qty + " garments (no size breakdown)")) + "</span></span>" +
          '<span class="log-who">Saved ' + esc(fmtWhen(b.at)) + (b.by ? " by " + esc(b.by) : "") + "</span></span>";
        if (!open) return '<div class="log-row box-row pick-row locked"><span class="pick-box" aria-hidden="true">' + (i + 1) + "</span>" + info +
          '<span class="log-btns"><span class="log-lock">LOCKED · 7-DAY REVIEW ENDED</span></span></div>';
        return '<div class="log-row box-row pick-row' + (on ? " on" : "") + '" role="checkbox" tabindex="0" aria-checked="' + on + '" aria-label="Select box ' + esc(b.name) + '" data-act="pick-box" data-id="' + esc(b.id) + '">' +
          '<span class="pick-box" aria-hidden="true">' + (on ? ICON.tick : "") + "</span>" + info + "</div>";
      }
      var btns = (onBoard ? '<button class="log-btn" data-act="open-dup" data-id="' + esc(b.id) + '">DUPLICATE BOX</button>' : "") +
        (open ? '<button class="log-btn" data-act="open-edit" data-id="' + esc(b.id) + '">EDIT BOX</button>' +
                '<button class="log-btn del" data-act="open-del" data-id="' + esc(b.id) + '">DELETE BOX</button>'
              : '<span class="log-lock">LOCKED · 7-DAY REVIEW ENDED</span>');
      return '<div class="log-row box-row"><span class="log-icon">' + (i + 1) + "</span>" +
        '<span class="log-text"><span class="log-main">' +
        '<span class="kv"><span class="k">GARMENT TYPE</span>' + esc(b.name) + "</span>" +
        '<span class="kv"><span class="k">PACKAGING TYPE</span>' + esc(b.type || "—") + "</span>" +
        '<span class="kv"><span class="k">QUANTITY + SIZE COUNTED</span>' + esc(b.sizes || (b.qty + " garments (no size breakdown)")) + "</span></span>" +
        '<span class="log-who">Saved ' + esc(fmtWhen(b.at)) + (b.by ? " by " + esc(b.by) : "") +
        (open ? " · can be changed until " + esc(fmtWhen(b.editableUntil)) : " · read-only since " + esc(fmtWhen(b.editableUntil))) + "</span></span>" +
        '<span class="log-btns">' + btns + "</span></div>";
    }).join("");
  }

  /* ----------------------------------------------------- sizes changed --- */
  /* SIZES CHANGED (11-04, from the approved "The Catch: Sizes Changed" mockup): the supplier sent
     different sizes, the customer OK'd printing what arrived. For one garment the catcher types how
     many of each size arrived, and why; /api/size-change writes it to the order's Size Changes field,
     and from then on the app counts that garment against what arrived. Order products never change. */
  function szOrdered(s) { return s.ordered != null ? s.ordered : s.qty; }
  function szDiffs(o) {
    var z = state.sz, l = o && o.lines[z.line];
    if (!l) return [];
    return l.sizes.map(function (s) {
      var v = z.vals[s.size], got = v === "" || v == null ? null : parseInt(v, 10);
      return { size: s.size, ordered: szOrdered(s), received: got };
    }).filter(function (d) { return d.received !== null && d.received !== d.ordered; });
  }
  function openSizes(o, li) {
    var l = o.lines[li]; if (!l) return;
    var vals = {};
    l.sizes.forEach(function (s) { vals[s.size] = String(s.received != null ? s.received : s.qty); });
    state.sz = { line: li, vals: vals, sel: l.sizes[0] ? l.sizes[0].size : null, fresh: true, note: l.changed ? l.changed.note || "" : "", requestId: newRequestId() };
    state.sheet = "sz"; state.toast = null; renderToast(); renderOverlay();
  }
  function szSaveLabel(o) {
    var z = state.sz, l = o.lines[z.line];
    var diffs = szDiffs(o), blank = l.sizes.some(function (s) { return z.vals[s.size] === ""; }), noteOk = z.note.trim().length >= 3;
    var label = state.saving ? '<span class="spin"></span>SAVING…'
      : blank ? "TYPE A NUMBER FOR EVERY SIZE"
      : diffs.length && !noteOk ? "WRITE WHY BELOW"
      : diffs.length ? "SAVE SIZE CHANGE · " + diffs.map(function (d) { var n = d.received - d.ordered; return esc(d.size) + " " + (n > 0 ? "+" + n : "−" + (-n)); }).join(", ")
      : l.changed ? "PUT BACK TO THE ORDERED SIZES" : "NO SIZES CHANGED YET";
    return { label: label, ready: !state.saving && !blank && (diffs.length ? noteOk : !!l.changed) };
  }
  function szSheetHtml(o) {
    var z = state.sz, l = o.lines[z.line];
    if (!l) return "";
    var ordT = 0, gotT = 0;
    var rows = l.sizes.map(function (s) {
      var ord = szOrdered(s), v = z.vals[s.size], got = v === "" ? null : parseInt(v, 10);
      ordT += ord; gotT += got || 0;
      var d = got === null ? null : got - ord, sel = z.sel === s.size;
      var change = got === null ? '<span class="sz-same">type a number</span>' : d === 0 ? '<span class="sz-same">same</span>'
        : '<span class="sz-diff">' + (d > 0 ? "+" + d + " · " + d + " more" : "−" + (-d) + " · " + (-d) + " fewer") + "</span>";
      return '<div class="sz-row' + (d ? " on" : "") + '"><span class="sz-size">' + esc(s.size) + '</span><span class="sz-ord">' + ord + "</span>" +
        '<button class="sz-cell' + (d ? " on" : "") + '" data-act="sz-cell" data-k="' + esc(s.size) + '" aria-pressed="' + sel + '" aria-label="' + esc(s.size) + " received: " + (v === "" ? "blank" : v) + '">' + (v === "" ? "—" : esc(v)) + "</button>" + change + "</div>";
    }).join("");
    var totNote = gotT === ordT ? "same total, different sizes" : gotT > ordT ? (gotT - ordT) + " more in all" : (ordT - gotT) + " fewer in all";
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"].map(function (k) {
      var lab = k === "<" ? "⌫" : k === "C" ? "CLR" : k;
      return '<button data-act="sz-key" data-k="' + k + '" class="' + (k === "<" || k === "C" ? "k2" : "") + '" aria-label="' + (k === "<" ? "Delete last digit" : k === "C" ? "Clear" : k) + '">' + lab + "</button>";
    }).join("");
    var sv = szSaveLabel(o);
    return '<div class="scrim"><div class="sheet wide sz-sheet" role="dialog" aria-label="Sizes changed">' +
      '<div class="sheet-head"><div class="sheet-title"><h2 class="sz-title">SIZES CHANGED · ' + esc(o.num) + "</h2>" +
      "<p>" + esc((l.color ? l.color + " · " : "") + l.product) + " · type how many of each size actually arrived</p></div>" +
      '<button class="x" data-act="close" aria-label="Close"' + (state.saving ? " disabled" : "") + ">" + ICON.x + "</button></div>" +
      '<div class="row2"><div class="grow sz-table"><div class="sz-row sz-headrow"><span>SIZE</span><span>ORDERED</span><span>RECEIVED</span><span>CHANGE</span></div>' + rows +
      '<div class="sz-row sz-total"><span>TOTAL</span><span class="sz-ord">' + ordT + '</span><span class="sz-tot">' + gotT + '</span><span class="sz-same">' + totNote + "</span></div></div>" +
      '<div class="pad-wrap"><div class="pad-for">RECEIVED FOR <b>' + esc(z.sel || "") + '</b></div><div class="pad">' + keys + "</div>" +
      '<div class="quick"><button class="chip" data-act="sz-next">Next size →</button></div></div></div>' +
      '<div class="sz-why"><label for="sz-note" class="sec-label">WHY? · SAVED TO SALESFORCE WITH THE SIZES</label>' +
      '<textarea id="sz-note" class="note-in" rows="2" maxlength="200" placeholder="e.g. Supplier sent 3 more L and 3 fewer M. Customer OK’d printing what we got.">' + esc(z.note) + "</textarea></div>" +
      '<div class="save-row sz-save-row"><button class="save alt" data-act="close"' + (state.saving ? " disabled" : "") + ">CANCEL</button>" +
      '<button class="save sz-save' + (state.saving ? " busy" : "") + '" data-act="sz-save"' + (sv.ready ? "" : " disabled") + ">" + sv.label + "</button></div></div></div>";
  }

  /* ---------------------------------------------- select + delete boxes -- */
  /* SELECT (11-02): under "Boxes on this order", tick several boxes and delete them together.
     Only boxes still inside their 7-day review can be ticked; the server checks every one again
     and deletes all or none (/api/box-delete-many). Leaving the order or the list ends SELECT. */
  function pickable(o) { return o.boxes.filter(function (b) { return canChangeBox(withWindow(b)); }); }
  function pickingFor(o) {
    var pk = state.picking;
    if (!pk || !o || pk.orderId !== o.id) return null;
    var ok = {};
    pickable(o).forEach(function (b) { ok[b.id] = true; });
    Object.keys(pk.ids).forEach(function (id) { if (!ok[id]) delete pk.ids[id]; });   // deleted or locked meanwhile
    return pk;
  }
  function pickedBoxes(o) {
    var pk = pickingFor(o);
    return pk ? o.boxes.filter(function (b) { return pk.ids[b.id]; }) : [];
  }
  function boxLogHtml(o, onBoard, label, rows, emptyText, extra) {
    var pk = pickingFor(o), can = pickable(o).length, head = "";
    if (pk) {
      var all = can && pickedBoxes(o).length === can;
      head = '<span class="log-tools"><button class="log-btn" data-act="pick-all">' + (all ? "CLEAR ALL" : "SELECT ALL · " + can) + "</button>" +
        '<button class="log-btn" data-act="pick-cancel">CANCEL</button></span>';
    } else if (can >= 2) {
      head = '<span class="log-tools"><button class="log-btn" data-act="pick-start">' + ICON.tick + "SELECT</button></span>";
    }
    var bar = "";
    if (pk) {
      var picked = pickedBoxes(o), n = picked.length, g = picked.reduce(function (a, b) { return a + (Number(b.qty) || 0); }, 0);
      bar = '<div class="pick-bar" role="region" aria-label="Selected boxes"><span class="pick-count">' +
        (n ? "<b>" + n + (n === 1 ? " BOX" : " BOXES") + "</b> SELECTED · " + g + " garments" : "<b>TAP BOXES</b> TO SELECT THEM") + "</span>" +
        '<button class="save danger pick-del" data-act="pick-delete"' + (n ? "" : " disabled") + ">" + (n ? "DELETE " + n + (n === 1 ? " BOX" : " BOXES") : "DELETE") + "</button></div>";
    }
    return '<div class="log' + (pk ? " picking" : "") + '"><div class="log-head"><div class="sec-label">' + label + "</div>" + head + "</div>" +
      (rows || '<div class="empty" style="margin:0">' + emptyText + "</div>") + bar + extra + "</div>";
  }
  function delManySheetHtml(o) {
    var d = state.delMany;
    var list = o.boxes.filter(function (b) { return d.ids.indexOf(b.id) >= 0; });
    if (!list.length) return "";
    var n = list.length, g = list.reduce(function (a, b) { return a + (Number(b.qty) || 0); }, 0);
    return '<div class="scrim"><div class="sheet" role="alertdialog" aria-label="Delete boxes">' +
      '<div class="sheet-head"><div class="sheet-title"><h2 class="danger">DELETE ' + n + (n === 1 ? " BOX" : " BOXES") + " · " + esc(o.num) + "?</h2>" +
      "<p>" + g + " garments in all</p></div>" +
      '<button class="x" data-act="close" aria-label="Close"' + (state.saving ? " disabled" : "") + ">" + ICON.x + "</button></div>" +
      '<div class="del-list">' + list.map(function (b) {
        return '<div class="del-item"><b>' + esc(b.name) + "</b><span>" + esc(b.type || "—") + " · " + esc(b.sizes || b.qty + " garments") + "</span></div>";
      }).join("") + "</div>" +
      '<div class="fin-warn">Deleting removes ' + (n === 1 ? "this box's saved record" : "these " + n + " boxes' saved records") + " from Salesforce, all together or none at all. They will no longer count toward this order's boxes" +
      (o.finished ? ", and the order's Packaging Count will drop to " + (o.boxes.length - n) : "") + ". Only do this if they were logged by mistake.</div>" +
      '<div class="save-row"><button class="save alt" data-act="close"' + (state.saving ? " disabled" : "") + ">" + (n === 1 ? "KEEP IT" : "KEEP THEM") + "</button>" +
      '<button class="save danger' + (state.saving ? " busy" : "") + '" data-act="delmany-confirm"' + (state.saving ? " disabled" : "") + ">" +
      (state.saving ? '<span class="spin"></span>DELETING…' : "YES, DELETE " + n + (n === 1 ? " BOX" : " BOXES")) + "</button></div></div></div>";
  }

  /** Past Orders: one order's saved boxes, for review. No logging, no finishing. */
  function pastDetailHtml(o) {
    var split = boxedSplit(o), boxed = split.ordered;
    var open = o.boxes.filter(function (b) { return canChangeBox(withWindow(b)); }).length;
    var where = o.inProduction ? "STILL IN PRODUCTION" : String(o.status || "").toUpperCase() || "NOT IN PRODUCTION";
    return '<main class="detail">' +
      '<button class="back narrow-only" data-act="back">' + ICON.back + "PAST ORDERS</button>" +
      '<div class="review-banner"><b>REVIEWING PAST ORDER ' + esc(o.num) + "</b>" +
      (open ? open + (open === 1 ? " box" : " boxes") + " can still be edited or deleted. Each box can be changed for 7 days after it was saved."
            : "Every box on this order is past its 7-day review period, so it's read-only.") + "</div>" +
      '<div class="d-top"><div class="d-id"><h2 class="d-num">' + esc(o.num) + "</h2>" +
      '<div class="d-cust">' + esc(o.customer) + "</div>" + deliveryBadge(o, "dm-big") +
      '<div class="d-meta">Print date ' + esc(fmtDate(o.printDate)) + " · " + esc(where) + (o.finished ? " · Packaging Count " + o.finishedCount : "") + "</div></div></div>" +
      '<div class="stats"><div class="stat"><div class="l">BOXES</div><div class="v">' + o.boxes.length + "</div></div>" +
      '<div class="stat"><div class="l">BOXED</div><div class="v">' + boxed + " <small>/ " + o.total + (split.extra ? " · +" + split.extra + " extra" : "") + "</small></div></div>" +
      '<div class="stat"><div class="l">EDITABLE</div><div class="v">' + open + "</div></div></div>" +
      boxLogHtml(o, false, "BOXES ON THIS ORDER (FROM SALESFORCE)", boxRowsHtml(o, false), "No boxes on this order any more.", "") + "</main>";
  }

  /** Fulfillment order: finished with a box count of 0 and no boxes logged (10-21). */
  /** Delivery Method badge (Salesforce Order "Delivery Method"). Nothing when Salesforce didn't send it. */
  function deliveryBadge(o, cls) {
    var d = o && o.delivery;
    if (!d || !d.label) return "";
    var key = /^[a-z]+$/.test(d.key) ? d.key : "other";
    return '<span class="dm dm-' + key + (cls ? " " + cls : "") + '" title="Delivery method">' + esc(d.label) + "</span>";
  }

  function isFulfillment(o) { return !!o.finished && Number(o.finishedCount) === 0 && !o.boxes.length; }

  function finishBtn(o) {
    var n = o.boxes.length;
    if (isFulfillment(o)) return '<div class="big big-ful done" role="status">' + ICON.check + "FULFILLMENT ORDER. NO BOXES.</div>";
    if (!n) return '<div class="fin-row"><button class="big big-done" disabled>' + ICON.check + "FINISH CATCHING · LOG A BOX FIRST</button>" +
      '<button class="big big-ful" data-act="open-ful">' + ICON.box + "FULFILLMENT</button></div>";
    if (o.finished && o.finishedCount === n) return '<button class="big big-done" data-act="open-fin">' + ICON.check + "COUNTED · " + n + (n === 1 ? " BOX" : " BOXES") + "</button>";
    return '<button class="big big-done go" data-act="open-fin">' + ICON.check + (o.finished ? "UPDATE COUNT · " : "FINISH CATCHING · ") + n + (n === 1 ? " BOX" : " BOXES") + "</button>";
  }

  function finSheetHtml(o) {
    if (state.fin && state.fin.fulfillment) {
      return '<div class="scrim"><div class="sheet" role="dialog" aria-label="Fulfillment order">' +
        '<div class="sheet-head"><div class="sheet-title"><h2>FULFILLMENT · ' + esc(o.num) + "</h2>" +
        "<p>Skips boxing. Saves this order in Salesforce as a fulfillment order with no boxes (Packaging Count 0)" + (o.inProduction ? "." : ", then it leaves your board.") + "</p></div>" +
        '<button class="x" data-act="close" aria-label="Close">' + ICON.x + "</button></div>" +
        '<div class="fin-warn">Only for orders that go to fulfillment without being boxed here. If any garments get boxed, close this and use LOG BOXES instead.</div>' +
        '<button class="save ok' + (state.saving ? " busy" : "") + '" data-act="save-fin"' + (state.saving ? " disabled" : "") + ">" +
        (state.saving ? '<span class="spin"></span>SAVING TO SALESFORCE…' : "YES, FULFILLMENT ORDER. NO BOXES.") + "</button></div></div>";
    }
    var n = o.boxes.length, split = boxedSplit(o), boxed = split.ordered;
    var short = boxed !== o.total;
    return '<div class="scrim"><div class="sheet" role="dialog" aria-label="Finish catching">' +
      '<div class="sheet-head"><div class="sheet-title"><h2>FINISH CATCHING · ' + esc(o.num) + "</h2>" +
      "<p>Saves " + n + " as this order's box count in Salesforce" + (o.inProduction ? "." : ", then it leaves your board.") + "</p></div>" +
      '<button class="x" data-act="close" aria-label="Close">' + ICON.x + "</button></div>" +
      '<div class="fin-sum"><div class="stat"><div class="l">BOXES</div><div class="v">' + n + '</div></div>' +
      '<div class="stat"><div class="l">GARMENTS BOXED</div><div class="v' + (short ? " warn" : "") + '">' + boxed + " <small>/ " + o.total + (split.extra ? " · +" + split.extra + " extra" : "") + "</small></div></div></div>" +
      (short ? '<div class="fin-warn">The boxes hold ' + boxed + " of the order's garments but the order has " + o.total + (split.extra ? " (plus " + split.extra + " extra)" : "") + ". If that's right (misprints, extras), finish anyway. If not, close this and log the missing box.</div>" : "") +
      '<button class="save ok' + (state.saving ? " busy" : "") + '" data-act="save-fin"' + (state.saving ? " disabled" : "") + ">" +
      (state.saving ? '<span class="spin"></span>SAVING TO SALESFORCE…' : "YES, I'M DONE · " + n + (n === 1 ? " BOX" : " BOXES")) + "</button></div></div>";
  }

  /* ----------------------------------------------------------- sheets ---- */
  /* Box sheet. Field names follow Salesforce (Order Packaging):
       Garment Type (Name) · Packaging Type · Quantity + Size Counted (+ the total in Packaging Quantity). */
  function cellKey(li, size) { return li + "|" + size; }
  function boxCounts(o, b) {
    var out = [];
    o.lines.forEach(function (l, li) {
      l.sizes.forEach(function (s) {
        var q = parseInt(b.cells[cellKey(li, s.size)] || "0", 10) || 0;
        if (q) out.push({ line: li, size: s.size, qty: q });
      });
      extrasFor(o, b, li).forEach(function (sz) {
        var q = parseInt(b.cells[cellKey(li, sz)] || "0", 10) || 0;
        if (q) out.push({ line: li, size: sz, qty: q, extra: true });
      });
    });
    return out;
  }
  function boxTotal(o, b) { return boxCounts(o, b).reduce(function (a, c) { return a + c.qty; }, 0); }

  /* ---- ADD MORE: extras (Anthony 2026-10-26) ----
     The supplier sometimes sends extras that get printed and boxed for the customer.
     "+ ADD MORE" on the box form adds a size that ISN'T on the order to this box; it's
     saved as e.g. "2XL 3 (extra)". Extras of a size already on the order are just
     counted in that size, past what's left. Extras are shown apart from the order's
     own count everywhere ("300 of 300 boxed + 6 extra"). */
  var EXTRA_PICKS = ["YXS", "YS", "YM", "YL", "YXL", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "OSFA"];
  function cleanExtraSize(v) {
    v = String(v == null ? "" : v).toUpperCase().replace(/\s+/g, " ").trim();
    return /^[A-Z0-9][A-Z0-9 \/.-]{0,9}$/.test(v) ? v : "";
  }
  function sizeOnLine(l, size) {
    var u = String(size).toUpperCase();
    return l.sizes.filter(function (s) { return s.size.toUpperCase() === u; })[0] || null;
  }
  /** Extra sizes for garment line li: ones already boxed on this order, then ones added in this form. */
  function extrasFor(o, b, li) {
    var l = o.lines[li], out = [];
    if (!l) return out;
    (l.extras || []).forEach(function (e) { if (out.indexOf(e.size) < 0) out.push(e.size); });
    ((b && b.added && b.added[li]) || []).forEach(function (sz) { if (out.indexOf(sz) < 0) out.push(sz); });
    return out;
  }
  function extraBoxedOf(l, size) {
    var e = (l.extras || []).filter(function (x) { return x.size === size; })[0];
    return e ? e.boxed : 0;
  }
  /** Garments boxed: { all, extra, ordered } -- ordered = all minus extras (what counts against the order). */
  function boxedSplit(o) {
    var all = 0, extra = 0;
    o.boxes.forEach(function (b) {
      all += Number(b.qty) || 0;
      (b.counts || []).forEach(function (c) { if (c.extra) extra += c.qty; });
    });
    return { all: all, extra: extra, ordered: all - extra };
  }
  function extraNote(n) { return n ? " + " + n + " extra" : ""; }
  /** Add an extra size to the open box form and select it for counting. */
  function addExtra(li, raw) {
    var o = current(), b = state.box; if (!o || !b) return;
    var l = o.lines[li]; if (!l) return;
    var size = cleanExtraSize(raw);
    if (!size) { showToast({ kind: "err", title: "CAN'T USE THAT SIZE", body: "Type a size with letters and numbers, up to 10 characters (for example 6XL)." }); return; }
    var same = sizeOnLine(l, size);
    if (same) {
      b.sel = cellKey(li, same.size); b.adding = null; renderOverlay();
      showToast({ kind: "ok", title: same.size + " IS ON THE ORDER", body: "Count the extra " + same.size + " in its own size. It can go past what's left." });
      return;
    }
    if (!b.added) b.added = {};
    if (!b.added[li]) b.added[li] = [];
    if (extrasFor(o, b, li).indexOf(size) < 0) b.added[li].push(size);
    b.sel = cellKey(li, size); b.adding = null; renderOverlay();
  }

  /** Garment Type, e.g. "Tees 3" -- the shop word for what's in the box, and the box number. */
  function boxName(o, b) {
    var used = {};
    boxCounts(o, b).forEach(function (c) { used[lineWord(o.lines[c.line])] = 1; });
    var words = Object.keys(used);
    var short = words.length ? words.join(" + ") : lineWord(o.lines[0]);
    // Next number after the highest one already used for this Garment Type (same rule as the server).
    var top = 0;
    o.boxes.forEach(function (x) {
      var nm = String(x.name || "");
      if (nm === short) top = Math.max(top, 1);
      else if (nm.indexOf(short + " ") === 0 && /^\d+$/.test(nm.slice(short.length + 1))) top = Math.max(top, Number(nm.slice(short.length + 1)));
    });
    return short + " " + (top + 1);
  }

  function sizeLeft(s) {
    return s.qty - (s.boxed || 0);
  }
  /* BOXES LIKE THIS (11-02): how many identical boxes Log Box saves at once (1-100, default 1).
     Typed on the same keypad: tap the tile, then the digits. 0 = not a valid number yet. */
  var MAX_COPIES = 100;
  function copiesN(b) {
    var v = String(b && b.copies != null ? b.copies : "1");
    if (!/^[0-9]{1,3}$/.test(v)) return 0;
    var n = parseInt(v, 10);
    return n >= 1 && n <= MAX_COPIES ? n : 0;
  }
  /** Sizes this many boxes would over-fill: [{ size, need, left }]. Extras are not on the order, so never "over". */
  function copiesOver(o, b, n) {
    var out = [];
    boxCounts(o, b).forEach(function (c) {
      if (c.extra) return;
      var s = o.lines[c.line].sizes.filter(function (x) { return x.size === c.size; })[0];
      if (s && c.qty * n > sizeLeft(s)) out.push({ size: c.size, need: c.qty * n, left: Math.max(0, sizeLeft(s)) });
    });
    return out;
  }

  function boxSheetHtml(o) {
    var b = state.box, total = boxTotal(o, b), ed = b.edit;
    var orig = ed ? ed.orig : {};
    var split = boxedSplit(o), boxed = split.ordered;
    var types = state.boxTypes.length ? state.boxTypes.map(function (t) {
      return '<button class="chip" data-act="box-type" data-v="' + esc(t.value) + '" aria-pressed="' + (b.type === t.value) + '">' + esc(t.label) + "</button>";
    }).join("") : '<div class="hint">Packaging types could not be loaded. Close and try again.</div>';
    var groups = o.lines.map(function (l, li) {
      var lineCount = 0;
      var cells = l.sizes.map(function (s) {
        var k = cellKey(li, s.size), v = b.cells[k] || "", q = parseInt(v || "0", 10) || 0, left = sizeLeft(s) + (orig[k] || 0);
        lineCount += q;
        var chg = s.ordered != null && s.ordered !== s.qty;   // SIZES CHANGED: counting against what arrived
        return '<button class="cell' + (q ? " has" : "") + (q > left ? " over" : "") + (chg ? " chg" : "") + '" data-act="box-cell" data-k="' + esc(k) + '" aria-pressed="' + (b.sel === k) + '" aria-label="' + esc(s.size) + ", " + q + ' counted">' +
          '<span class="s">' + esc(s.size) + '</span><span class="q">' + (v || "0") + '</span><span class="left">' + Math.max(0, left) + (chg ? " of " + s.qty : "") + " left</span></button>";
      }).join("");
      // Extras: sizes not on the order (already boxed on it, or added just now with + ADD MORE).
      cells += extrasFor(o, b, li).map(function (sz) {
        var k = cellKey(li, sz), v = b.cells[k] || "", q = parseInt(v || "0", 10) || 0, prior = extraBoxedOf(l, sz) - (orig[k] || 0);
        lineCount += q;
        return '<button class="cell extra' + (q ? " has" : "") + '" data-act="box-cell" data-k="' + esc(k) + '" aria-pressed="' + (b.sel === k) + '" aria-label="' + esc(sz) + ", extra, " + q + ' counted">' +
          '<span class="s">' + esc(sz) + '</span><span class="q">' + (v || "0") + '</span><span class="left">EXTRA' + (prior > 0 ? " · " + prior + " boxed" : "") + "</span></button>";
      }).join("");
      var adding = !!(b.adding && b.adding.line === li);
      cells += '<button class="cell add-more" data-act="add-more" data-i="' + li + '" aria-pressed="' + adding + '" aria-label="Add more: an extra size that isn\'t on the order">' +
        '<span class="plus">+</span><span class="s">ADD MORE</span><span class="left">EXTRAS</span></button>';
      var picker = "";
      if (adding) {
        var have = extrasFor(o, b, li);
        var picks = EXTRA_PICKS.filter(function (p) { return !sizeOnLine(l, p) && have.indexOf(p) < 0; }).map(function (p) {
          return '<button class="chip" data-act="add-size" data-i="' + li + '" data-v="' + esc(p) + '">' + esc(p) + "</button>";
        }).join("");
        picker = '<div class="add-panel"><div class="sec-label">ADD AN EXTRA SIZE' + (o.lines.length > 1 ? " · " + esc(l.color || l.product) : "") + ' <span style="color:var(--text-ghost)">· NOT ON THE ORDER</span></div>' +
          (picks ? '<div class="chips small">' + picks + "</div>" : "") +
          '<div class="add-other"><input id="extra-size" class="note-in" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Other size, e.g. 6XL" aria-label="Other size" value="' + esc(b.adding.text || "") + '">' +
          '<button class="chip" data-act="add-other">ADD</button><button class="chip" data-act="add-cancel">CANCEL</button></div>' +
          '<div class="hint">Pick a size, then type how many on the number pad. Extras of a size that\'s already on the order: just count them in that size.</div></div>';
      }
      var szTag = l.changed ? ' <em class="sz-tag small">SIZES CHANGED · ' + l.changed.pairs.map(function (p) { return esc(p.size) + " " + p.ordered + "→" + p.received; }).join(" · ") + "</em>" : "";
      return '<div class="gl"><div class="gl-head">' + esc((l.color ? l.color + " · " : "") + l.product) + szTag + "<span>" + (lineCount ? lineCount + " in box" : "") + "</span></div>" +
        '<div class="cells">' + cells + "</div>" + picker + "</div>";
    }).join("");
    if (!o.lines.length) groups = '<div class="hint">This order has no garment sizes in Salesforce, so sizes can\'t be counted. Tell a manager.</div>';
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"].map(function (k) {
      var label = k === "<" ? "⌫" : k === "C" ? "CLR" : k;
      return '<button data-act="box-key" data-k="' + k + '" class="' + (k === "<" || k === "C" ? "k2" : "") + '" aria-label="' + (k === "<" ? "Delete last digit" : k === "C" ? "Clear this size" : k) + '">' + label + "</button>";
    }).join("");
    var selParts = b.sel ? b.sel.split("|") : null;
    var selLine = selParts ? o.lines[Number(selParts[0])] : null;
    var selName = selParts ? selParts.slice(1).join("|") : "";
    var selSize = selLine ? selLine.sizes.filter(function (s) { return s.size === selName; })[0] : null;
    var selExtra = !selSize && selLine && extrasFor(o, b, Number(selParts[0])).indexOf(selName) >= 0;
    var restN = selSize ? Math.max(0, sizeLeft(selSize) + (orig[b.sel] || 0)) : 0;
    var selCopies = !ed && b.sel === "copies", n = ed ? 1 : copiesN(b);
    var ready = total > 0 && total <= 9999 && !!b.type && (!ed || !!b.word) && n > 0;
    var label = state.saving ? "SAVING TO SALESFORCE…" : !ready ? (!b.type ? "PICK A PACKAGING TYPE" : !total ? "COUNT AT LEAST ONE SIZE" : !n ? "BOXES LIKE THIS: 1 TO " + MAX_COPIES : "COUNT AT LEAST ONE SIZE")
      : ed ? "SAVE CHANGES · " + total + " GARMENTS"
      : n > 1 ? "SAVE " + n + " BOXES · " + total + " EACH · " + (total * n) + " GARMENTS"
      : "SAVE BOX " + (o.boxes.length + 1) + " · " + total + " GARMENTS";
    var gtName = ed ? b.word + (ed.num ? " " + ed.num : "") : boxName(o, b);
    if (!ed && n > 1) {
      var gm = gtName.match(/^(.*\D)\s(\d+)$/);
      if (gm) gtName = gtName + " to " + gm[1] + " " + (Number(gm[2]) + n - 1);
    }
    var over = !ed && n > 1 && total ? copiesOver(o, b, n) : [];
    var copiesTile = ed ? "" : '<button class="copies' + (selCopies ? " sel" : "") + (n > 1 ? " has" : "") + (!n ? " bad" : "") + '" data-act="box-cell" data-k="copies" aria-pressed="' + selCopies + '" aria-label="Boxes like this: ' + (b.copies || "") + '">' +
      '<span class="l">BOXES LIKE THIS</span><span class="v">× ' + esc(b.copies == null ? "1" : b.copies || "—") + "</span>" +
      '<span class="h">' + (selCopies ? "TYPE ON THE KEYPAD" : "TAP TO CHANGE") + "</span></button>";
    var words = [];
    if (ed) {
      o.lines.forEach(function (l) { var w = lineWord(l); if (words.indexOf(w) < 0) words.push(w); });
      if (words.indexOf(ed.word0) < 0) words.unshift(ed.word0);
    }
    var wordChips = ed ? '<div><div class="sec-label">GARMENT TYPE <span style="color:var(--text-ghost)">· BOX NUMBER ' + esc(ed.num || "—") + ' STAYS THE SAME</span></div><div class="chips">' +
      words.map(function (w) { return '<button class="chip" data-act="box-word" data-v="' + esc(w) + '" aria-pressed="' + (b.word === w) + '">' + esc(w) + "</button>"; }).join("") + "</div></div>" : "";
    return '<div class="scrim"><div class="sheet wide" role="dialog" aria-label="' + (ed ? "Edit a box" : "Log a box") + '">' +
      '<div class="sheet-head"><div class="sheet-title"><h2>' + (ed ? "EDIT BOX “" + esc(ed.name0) + "” · " + esc(o.num) : "LOG BOX " + (o.boxes.length + 1) + " · " + esc(o.num)) + "</h2>" +
      "<p>" + (ed ? "Saved " + esc(fmtWhen(ed.at)) + " · can be changed until " + esc(fmtWhen(ed.until)) + ". Saving changes this box; it doesn't make a new one."
                  : o.boxes.length + (o.boxes.length === 1 ? " box" : " boxes") + " saved · " + boxed + " of " + o.total + " garments boxed" + extraNote(split.extra)) + "</p></div>" +
      '<button class="x" data-act="close" aria-label="Close">' + ICON.x + "</button></div>" +
      (ed && !ed.hadSizes ? '<div class="fin-warn">This box was saved without sizes (' + ed.qty0 + " garments). Count its sizes below to save a change.</div>" : "") +
      wordChips +
      '<div><div class="sec-label">' + (ed ? "" : "1 · ") + 'PACKAGING TYPE</div><div class="chips">' + types + "</div></div>" +
      '<div class="row2"><div class="grow"><div class="sec-label">' + (ed ? "" : "2 · ") + 'QUANTITY + SIZE COUNTED <span style="color:var(--text-ghost)">· TAP A SIZE, TYPE THE COUNT</span></div>' + groups + "</div>" +
      '<div class="pad-wrap"><div class="pad-for">' + (selCopies ? "HOW MANY <b>BOXES LIKE THIS</b> · 1 TO " + MAX_COPIES : selSize || selExtra ? "COUNT FOR <b>" + esc(selName) + "</b>" + (selExtra ? " · EXTRA" : "") + (o.lines.length > 1 ? " · " + esc(selLine.color || selLine.product) : "") : "TAP A SIZE") + "</div>" +
      '<div class="pad">' + keys + "</div>" +
      '<div class="quick"><button data-act="box-rest"' + (selSize && restN ? "" : " disabled") + ">Rest of " + (selSize ? esc(selSize.size) : "size") + " (" + restN + ")</button>" +
      '<button data-act="box-next"' + (selSize || selExtra ? "" : " disabled") + ">Next size →</button></div></div></div>" +
      '<div class="total-bar' + (total ? " on" : "") + '"><div><div class="l">' + (n > 1 ? "IN EACH BOX" : "TOTAL IN THIS BOX") + '</div><div class="v" aria-live="polite">' + total + "</div></div>" +
      copiesTile +
      '<div class="gt">Garment Type<b>' + esc(gtName) + "</b></div></div>" +
      (total > 9999 ? '<div class="fin-warn">One box can hold at most 9999 garments.</div>' : "") +
      (!ed && !n ? '<div class="fin-warn">Boxes like this: type a number from 1 to ' + MAX_COPIES + ".</div>" : "") +
      (over.length ? '<div class="fin-warn">' + n + " boxes × " + total + " = " + (total * n) + " garments, more than the order has left in " +
        over.map(function (x) { return esc(x.size) + " (" + x.need + " for " + x.left + " left)"; }).join(", ") + ". Check the number of boxes.</div>" : "") +
      '<div class="save-row"><button class="save' + (state.saving ? " busy" : "") + '" data-act="' + (ed ? "save-edit" : "save-box") + '"' + (ready && !state.saving ? "" : " disabled") + ">" +
      (state.saving ? '<span class="spin"></span>' : "") + label + "</button>" +
      (ed ? '<button class="save alt" data-act="close"' + (state.saving ? " disabled" : "") + ">CANCEL</button>"
          : '<button class="save alt" data-act="save-box-new"' + (ready && !state.saving ? "" : " disabled") + ">" + (n > 1 ? "SAVE " + n + " &amp; NEW" : "SAVE BOX &amp; NEW") + "</button>") + "</div></div></div>";
  }

  function delSheetHtml(o) {
    var d = state.del, b = o.boxes.filter(function (x) { return x.id === d.boxId; })[0];
    if (!b) return "";
    return '<div class="scrim"><div class="sheet" role="alertdialog" aria-label="Delete box">' +
      '<div class="sheet-head"><div class="sheet-title"><h2 class="danger">DELETE BOX “' + esc(b.name) + "” · " + esc(o.num) + "?</h2>" +
      "<p>Saved " + esc(fmtWhen(b.at)) + (b.by ? " by " + esc(b.by) : "") + "</p></div>" +
      '<button class="x" data-act="close" aria-label="Close"' + (state.saving ? " disabled" : "") + ">" + ICON.x + "</button></div>" +
      '<div class="dup-src"><div><span class="l">GARMENT TYPE</span>' + esc(b.name) + "</div>" +
      '<div><span class="l">PACKAGING TYPE</span>' + esc(b.type || "—") + "</div>" +
      '<div><span class="l">QUANTITY + SIZE COUNTED</span>' + esc(b.sizes || b.qty + " garments") + "</div></div>" +
      '<div class="fin-warn">Deleting removes this box\'s saved record from Salesforce. It will no longer count toward this order\'s boxes' +
      (o.finished ? ", and the order's Packaging Count will drop to " + (o.boxes.length - 1) : "") + ". Only do this if the box was logged by mistake.</div>" +
      '<div class="save-row"><button class="save alt" data-act="close"' + (state.saving ? " disabled" : "") + ">KEEP THE BOX</button>" +
      '<button class="save danger' + (state.saving ? " busy" : "") + '" data-act="del-confirm"' + (state.saving ? " disabled" : "") + ">" +
      (state.saving ? '<span class="spin"></span>DELETING…' : "YES, DELETE THIS BOX") + "</button></div></div></div>";
  }

  var MAX_DUP = 100;
  /** A whole number from 1 to 100, or 0 if the entry isn't one. */
  function dupCount(v) {
    var s = String(v == null ? "" : v);
    if (!/^[0-9]{1,3}$/.test(s)) return 0;
    var n = parseInt(s, 10);
    return n >= 1 && n <= MAX_DUP ? n : 0;
  }

  function dupSheetHtml(o) {
    var d = state.dup, src = o.boxes.filter(function (b) { return b.id === d.boxId; })[0];
    if (!src) return "";
    var n = dupCount(d.n), raw = d.n || "";
    var problem = !raw ? "Enter a number." : !n ? (parseInt(raw, 10) > MAX_DUP ? "The most is " + MAX_DUP + " at a time." : "Use a whole number from 1 to " + MAX_DUP + ".") : "";
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"].map(function (k) {
      var label = k === "<" ? "⌫" : k === "C" ? "CLR" : k;
      return '<button data-act="dup-key" data-k="' + k + '" class="' + (k === "<" || k === "C" ? "k2" : "") + '"' + (state.saving ? " disabled" : "") + ' aria-label="' + (k === "<" ? "Delete last digit" : k === "C" ? "Clear" : k) + '">' + label + "</button>";
    }).join("");
    return '<div class="scrim"><div class="sheet" role="dialog" aria-label="Duplicate box">' +
      '<div class="sheet-head"><div class="sheet-title"><h2>DUPLICATE BOX · ' + esc(o.num) + "</h2>" +
      "<p>Copies “" + esc(src.name) + "”. The original box is not changed.</p></div>" +
      '<button class="x" data-act="close" aria-label="Close"' + (state.saving ? " disabled" : "") + ">" + ICON.x + "</button></div>" +
      '<div class="dup-src"><div><span class="l">PACKAGING TYPE</span>' + esc(src.type) + "</div>" +
      "<div><span class=\"l\">QUANTITY + SIZE COUNTED</span>" + esc(src.sizes || (src.qty + " garments (no size breakdown on this box)")) + "</div></div>" +
      '<div class="row2"><div class="grow"><div class="sec-label">HOW MANY DUPLICATES WOULD YOU LIKE TO CREATE?</div>' +
      '<div class="stepper dup-stepper"><button data-act="dup-step" data-d="-1" aria-label="One fewer"' + (state.saving || n <= 1 ? " disabled" : "") + '>−</button>' +
      '<div class="v' + (n ? "" : " bad") + '" aria-live="polite">' + (raw || "–") + '</div><button data-act="dup-step" data-d="1" aria-label="One more"' + (state.saving || n >= MAX_DUP ? " disabled" : "") + ">+</button></div>" +
      '<div class="hint">' + (problem ? '<span class="dup-bad">' + problem + "</span>" : "Creates " + n + " new " + (n === 1 ? "box" : "boxes") + ": " + n * src.qty + " garments in all, each with its own record in Salesforce.") + "</div></div>" +
      '<div class="pad">' + keys + "</div></div>" +
      '<div class="save-row"><button class="save alt" data-act="close"' + (state.saving ? " disabled" : "") + ">CANCEL</button>" +
      '<button class="save' + (state.saving ? " busy" : "") + '" data-act="dup-confirm"' + (n && !state.saving ? "" : " disabled") + ">" +
      (state.saving ? '<span class="spin"></span>CREATING ' + n + (n === 1 ? " BOX" : " BOXES") + " IN SALESFORCE…" : "CONFIRM · CREATE " + (n || "") + (n === 1 ? " BOX" : " BOXES")) + "</button></div></div></div>";
  }

  function misSheetHtml(o) {
    var m = state.mis, line = o.lines[m.line] || { sizes: [] };
    var lineChips = o.lines.length > 1 ? '<div><div class="sec-label">GARMENT</div><div class="chips">' + o.lines.map(function (l, i) {
      return '<button class="chip" data-act="mis-line" data-i="' + i + '" aria-pressed="' + (m.line === i) + '">' + esc((l.color ? l.color + " " : "") + l.product) + "</button>";
    }).join("") + "</div></div>" : "";
    var sizes = line.sizes.concat(line.extras || []).map(function (s) {
      return '<button class="chip size-chip" data-act="mis-size" data-v="' + esc(s.size) + '" aria-pressed="' + (m.size === s.size) + '">' + esc(s.size) + "</button>";
    }).join("");
    var reasons = state.reasons.map(function (r) {
      return '<button class="chip" data-act="mis-reason" data-v="' + esc(r) + '" aria-pressed="' + (m.reason === r) + '">' + esc(r) + "</button>";
    }).join("");
    var ready = !!m.size && !!m.reason && m.qty > 0;
    var label = state.saving ? "SAVING TO SALESFORCE…" : ready ? "SAVE MISPRINT · " + m.qty + " × " + m.size : !m.size ? "PICK A SIZE" : "PICK WHAT WENT WRONG";
    return '<div class="scrim mis"><div class="sheet" role="dialog" aria-label="Report a misprint">' +
      '<div class="sheet-head"><div class="sheet-title"><h2 class="warn">REPORT MISPRINT · ' + esc(o.num) + "</h2>" +
      "<p>The print shop gets notified when this saves.</p></div>" +
      '<button class="x" data-act="close" aria-label="Close">' + ICON.x + "</button></div>" +
      lineChips +
      '<div class="row2"><div class="grow"><div class="sec-label">1 · SIZE</div><div class="chips small">' + (sizes || '<div class="hint">No sizes on this garment.</div>') + "</div></div>" +
      '<div style="width:15.5rem"><div class="sec-label">2 · HOW MANY</div><div class="stepper" style="margin-top:.6rem">' +
      '<button data-act="mis-minus" aria-label="One fewer">−</button><div class="v" aria-live="polite">' + m.qty + '</div><button data-act="mis-plus" aria-label="One more">+</button></div></div></div>' +
      '<div><div class="sec-label">3 · WHAT WENT WRONG</div><div class="chips">' + reasons + "</div></div>" +
      '<div style="display:flex;flex-direction:column;gap:.5rem"><label for="mis-note" class="sec-label">NOTE <span style="color:var(--text-ghost)">(OPTIONAL)</span></label>' +
      '<input id="mis-note" class="note-in" maxlength="80" autocomplete="off" placeholder="e.g. ink smudge on left sleeve" value="' + esc(m.note) + '"></div>' +
      '<button class="save warn' + (state.saving ? " busy" : "") + '" data-act="save-mis"' + (ready && !state.saving ? "" : " disabled") + ">" +
      (state.saving ? '<span class="spin"></span>' : "") + label + "</button></div></div>";
  }

  function viewerHtml(o) {
    var count = o.mockupCount || 1, i = Math.min(state.mockIdx || 0, count - 1);
    var flip = count > 1 ? '<div class="vzoom" role="group" aria-label="Which mockup"><button data-act="v-prev" aria-label="Previous mockup"' + (i <= 0 ? " disabled" : "") + '>‹</button><span>' + (i + 1) + " / " + count + '</span><button data-act="v-next" aria-label="Next mockup"' + (i >= count - 1 ? " disabled" : "") + ">›</button></div>" : "";
    return '<div class="viewer" role="dialog" aria-label="Mockup full size">' +
      '<div class="viewer-bar"><div class="t"><b>' + esc(o.num) + " · MOCKUP</b><span>" + esc(o.customer) + "</span></div>" + flip +
      '<div class="vzoom" role="group" aria-label="Mockup zoom"><button data-act="v-out" aria-label="Zoom out">−</button><span id="v-pct">100%</span><button data-act="v-in" aria-label="Zoom in">+</button></div>' +
      '<button class="vbtn" data-act="v-fit">FIT</button>' +
      '<button class="vbtn vclose" data-act="close">' + ICON.x + "CLOSE</button></div>" +
      '<div class="stage" id="stage"><img id="v-img" alt="Mockup for ' + esc(o.num) + '" data-mock="' + esc(o.id) + ":" + i + '"><span class="mock-wait mock-none">LOADING MOCKUP…</span>' +
      '<span class="tip">Pinch or double-tap to zoom · drag to move around</span></div></div>';
  }

  /*
   * Update the screen IN PLACE: walk the elements already on screen next to the
   * new version and change only what differs (a count, a total, a button label).
   * The form's scroll panel, the selected size and a focused text box are the same
   * elements before and after, so nothing jumps and focus isn't lost.
   * (Rebuilding the whole form on every tap is what used to throw the form back to the top.)
   */
  /* 3D buttons (buttons-3d.js, 11-02): a button keeps its ca-3d / ca-lip-N / ca-down / ca-live
     classes when a form is updated in place, so it never flickers flat or pops up mid-press. */
  var CA3D = /^ca-(3d|down|live|lip-\d+)$/;
  function keep3d(el) { return el.nodeName === "BUTTON" && /(^|\s)ca-3d(\s|$)/.test(el.getAttribute("class") || ""); }
  function with3d(cls, el) {
    if (!keep3d(el)) return cls;
    var mine = (el.getAttribute("class") || "").split(/\s+/).filter(function (c) { return CA3D.test(c); });
    return (cls ? cls + " " : "") + mine.join(" ");
  }
  function morph(from, to) {
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { from.parentNode.replaceChild(to, from); return; }
    if (from.nodeType === 3 || from.nodeType === 8) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
    if (from.nodeType !== 1) return;
    var i, a, v;
    for (i = from.attributes.length - 1; i >= 0; i--) { a = from.attributes[i]; if (to.hasAttribute(a.name)) continue;
      if (a.name === "class" && keep3d(from)) { v = with3d("", from); if (a.value !== v) from.setAttribute("class", v); } else from.removeAttribute(a.name); }
    for (i = 0; i < to.attributes.length; i++) {
      a = to.attributes[i]; v = a.name === "class" ? with3d(a.value, from) : a.value;
      if (from.getAttribute(a.name) !== v) from.setAttribute(a.name, v);
    }
    if (from.nodeName === "INPUT" || from.nodeName === "TEXTAREA") {
      var want = from.nodeName === "TEXTAREA" ? to.value : (to.getAttribute("value") || "");   // a textarea's text is its content
      if (document.activeElement !== from && from.value !== want) from.value = want;   // never fight the person typing
      return;
    }
    var fc = Array.prototype.slice.call(from.childNodes), tc = Array.prototype.slice.call(to.childNodes);
    for (i = 0; i < tc.length; i++) { if (i < fc.length) morph(fc[i], tc[i]); else from.appendChild(tc[i]); }
    for (i = fc.length - 1; i >= tc.length; i--) from.removeChild(fc[i]);
  }

  function renderOverlay() {
    var o = current();
    if (!state.user || !state.sheet || !o) { $overlay.innerHTML = ""; $overlay.removeAttribute("data-shown"); return; }
    if (state.sheet === "mock") { $overlay.innerHTML = viewerHtml(o); $overlay.removeAttribute("data-shown"); fillMockups($overlay); setupViewer(); return; }
    var html = state.sheet === "box" ? boxSheetHtml(o) : state.sheet === "mis" ? misSheetHtml(o) : state.sheet === "fin" ? finSheetHtml(o)
      : state.sheet === "dup" ? dupSheetHtml(o) : state.sheet === "del" ? delSheetHtml(o) : state.sheet === "delmany" && state.delMany ? delManySheetHtml(o) : state.sheet === "sz" && state.sz ? szSheetHtml(o) : "";
    // Which form for which order/box: a different one is drawn fresh; the same one is updated in place.
    var key = state.sheet + ":" + o.id + ":" + (state.box && state.box.requestId || "") + (state.dup ? ":" + state.dup.requestId : "") + (state.del ? ":" + state.del.requestId : "") + (state.delMany ? ":" + state.delMany.requestId : "") + (state.sheet === "sz" && state.sz ? ":" + state.sz.requestId : "");
    var old = $overlay.firstElementChild;
    if (old && $overlay.getAttribute("data-shown") === key) {
      var tmp = document.createElement("div"); tmp.innerHTML = html;
      if (tmp.firstElementChild) morph(old, tmp.firstElementChild);
    } else {
      $overlay.innerHTML = html;
      $overlay.setAttribute("data-shown", key);
    }
  }

  function renderToast() {
    var t = state.toast;
    if (!t) { $toast.innerHTML = ""; return; }
    $toast.innerHTML = '<div class="toast ' + t.kind + (state.sheet ? " top" : "") + '" role="status" aria-live="assertive">' +
      '<span class="ic">' + (t.kind === "ok" ? ICON.check : ICON.bang) + "</span>" +
      '<span class="tx"><b>' + esc(t.title) + "</b><span>" + esc(t.body) + "</span></span>" +
      (t.retry ? '<button class="retry" data-act="retry">TRY AGAIN</button>' : "") +
      '<button class="dismiss" data-act="dismiss" aria-label="Dismiss message">' + ICON.x + "</button></div>";
  }
  function showToast(t) {
    clearTimeout(toastTimer);
    state.toast = t; renderToast();
    if (t && t.kind === "ok") toastTimer = setTimeout(function () { state.toast = null; renderToast(); }, 7000);
  }


  /* ------------------------------------------------- Salesforce org ---- */
  /* 11-12 (Anthony): a PREVIEW Catch that can be switched between dev2 and staging, like The Forge,
     to test the Catch with The Forge. The live Catch is always Production and shows none of this.
     The server decides the org (functions/api/_sf.js); the tablet only shows it, sends it with every
     save (a save made on a screen still showing the old org is refused), and starts over when it changes. */
  function isTestOrg() { return !!(state.org && state.org.key && state.org.key !== "production"); }
  function paintOrg() {
    var chip = document.getElementById("org-chip"), show = !!(state.org && (state.org.switchable || isTestOrg()));
    chip.hidden = !show;
    if (show) document.getElementById("org-name").textContent = state.org.label || state.org.key;
    document.body.classList.toggle("org-test", isTestOrg());
    document.title = (isTestOrg() ? "[" + state.org.label + "] " : "") + "The Catch · Culture Apparel";
  }
  /** Ask the server which org this site is on (no sign-in needed: the PIN screen shows it too). */
  function loadOrg() {
    return api("GET", "/api/sf-env").then(function (r) {
      if (r.ok && r.data && r.data.active) {
        state.org = { key: r.data.active, label: r.data.label, switchable: !!r.data.switchable };
        if (state.orgsw) { state.orgsw.envs = r.data.environments || []; renderOrgSw(); }
        paintOrg(); if (!state.user) renderMain();
      }
      return r;
    });
  }
  /** The site is on another org now: drop everything from the old one and load the new one. */
  function orgChanged(key, label, tell) {
    var was = state.org ? state.org.label : "";
    state.org = Object.assign({}, state.org || {}, { key: key, label: label || key });
    state.orders = []; state.past = []; state.selId = null; state.pastSelId = null; state.view = "list";
    state.scr = { board: freshScreen(), past: freshScreen() };
    state.sheet = null; state.box = null; state.mis = null; state.fin = null; state.dup = null; state.del = null; state.delMany = null; state.sz = null;
    state.picking = null; state.pending = null; state.draft = null; state.boxTypes = []; state.q = "";
    Object.keys(mocks).forEach(function (id) { if (mocks[id].url) URL.revokeObjectURL(mocks[id].url); });
    mocks = {};
    paintOrg(); renderAll(); paintConn();
    if (tell) showToast({ kind: "unsure", title: "NOW ON " + String(state.org.label).toUpperCase(), body: "This preview was switched" + (was ? " from " + was : "") + " to " + state.org.label + ". The lists are reloading from it." });
    if (state.user) foregroundLoad(function () {
      return Promise.all([api("GET", "/api/box-types").then(function (r) { if (r.ok) state.boxTypes = r.data.types || []; }),
        state.mode === "past" ? loadPast() : loadOrders()]);
    });
  }

  function openOrgSw() {
    if (!state.org || !state.org.switchable) return;
    if (!state.user) { showToast({ kind: "err", title: "SIGN IN FIRST", body: "Sign in with your PIN, then tap " + state.org.label + " to switch." }); return; }
    if (state.saving) return;
    state.orgsw = { envs: [], pick: null, pin: "", busy: false, err: "" };
    renderOrgSw(); loadOrg();
  }
  function closeOrgSw() { if (state.orgsw && !state.orgsw.busy) { state.orgsw = null; renderOrgSw(); } }
  function renderOrgSw() {
    var w = state.orgsw;
    if (!w || !state.user) { $orgsw.innerHTML = ""; return; }
    var cur = state.org ? state.org.key : "";
    var envs = (w.envs || []).filter(function (e) { return e.key !== "production"; });
    var chips = envs.length ? envs.map(function (e) {
      var why = e.key === cur ? "IN USE NOW" : !e.configured ? "NO LOGIN SET UP" : "";
      return '<button class="chip" data-act="orgsw-pick" data-v="' + esc(e.key) + '" aria-pressed="' + (w.pick === e.key) + '"' + (e.selectable && e.key !== cur && !w.busy ? "" : " disabled") + ">" +
        "<span>" + esc(e.label) + (why ? "<small>" + why + "</small>" : "") + "</span></button>";
    }).join("") : '<div class="hint">Loading…</div>';
    var dots = ""; for (var i = 0; i < Math.max(4, w.pin.length); i++) dots += '<i class="' + (i < w.pin.length ? "on" : "") + '"></i>';
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"].map(function (k) {
      return '<button data-act="orgsw-key" data-k="' + k + '" class="' + (k === "<" || k === "C" ? "k2" : "") + '"' + (w.busy ? " disabled" : "") + ' aria-label="' + (k === "<" ? "Delete last digit" : k === "C" ? "Clear" : k) + '">' + (k === "<" ? "⌫" : k === "C" ? "CLEAR" : k) + "</button>";
    }).join("");
    var pickLabel = w.pick ? (envs.filter(function (e) { return e.key === w.pick; })[0] || {}).label || w.pick : "";
    var ready = !!w.pick && w.pin.length >= 4 && !w.busy;
    $orgsw.innerHTML = '<div class="scrim"><div class="sheet orgsw-sheet" role="dialog" aria-modal="true" aria-label="Switch Salesforce">' +
      '<div class="sheet-head"><div class="sheet-title"><h2 class="warn">SWITCH SALESFORCE</h2>' +
      "<p>This preview is on <b>" + esc(state.org.label) + "</b>. The live Catch on the floor stays on Production.</p></div>" +
      '<button class="x" data-act="orgsw-close" aria-label="Close"' + (w.busy ? " disabled" : "") + ">" + ICON.x + "</button></div>" +
      '<div><div class="sec-label">1 · WHICH ORG</div><div class="chips">' + chips + "</div></div>" +
      '<p class="orgsw-note">Every tablet using this preview moves with it. Open forms close and nothing unsaved is kept.</p>' +
      '<div><div class="sec-label">2 · SWITCH PIN</div><div class="dots">' + dots + '</div><div class="pin-pad">' + keys + "</div></div>" +
      '<p class="help-err" role="alert">' + esc(w.err) + "</p>" +
      '<button class="save warn' + (w.busy ? " busy" : "") + '" data-act="orgsw-go"' + (ready ? "" : " disabled") + ">" +
      (w.busy ? '<span class="spin"></span>CHECKING ' + esc(String(pickLabel).toUpperCase()) + "…" : w.pick ? "SWITCH TO " + esc(String(pickLabel).toUpperCase()) : "PICK AN ORG") + "</button></div></div>";
  }
  function orgSwGo() {
    var w = state.orgsw; if (!w || !w.pick || w.pin.length < 4 || w.busy) return;
    w.busy = true; w.err = ""; renderOrgSw();
    api("POST", "/api/sf-env", { env: w.pick, pin: w.pin }).then(function (r) {
      if (state.orgsw !== w) return;
      w.busy = false;
      if (r.ok && r.data && r.data.ok) {
        state.orgsw = null; renderOrgSw();
        orgChanged(r.data.active, r.data.label, false);
        showToast({ kind: "ok", title: "SWITCHED TO " + String(r.data.label).toUpperCase(), body: "This preview now reads and saves in " + r.data.label + ". Every preview tablet follows within a few seconds." });
      } else {
        w.pin = ""; w.err = (r.data && r.data.message) || "That didn't switch. Try again.";
        renderOrgSw();
      }
    });
  }

  /* -------------------------------------------------------------- help --- */
  /* HELP (11-02): the "?" in the header opens one pop-up, "Found a bug? Report it here:".
     The report goes to /api/bug-report, which emails Anthony and keeps a backup copy.
     Rebuilt from The Forge's Help page (Help Page Remake Guide), as a pop-up instead of a tab.
     What's typed is kept if the pop-up is closed, until it's sent or the catcher signs out. */
  var helpDraft = "";
  function helpWhere() {
    var o = current(), names = { box: "Log Boxes", mis: "Report Misprint", fin: "Finish Catching", dup: "Duplicate Box", del: "Delete Box", mock: "Mockup" };
    return (isTestOrg() ? "[" + state.org.label + " preview] " : "") + (state.mode === "past" ? "Past Orders" : "In Production") + (o ? " · " + o.num : "") + (state.sheet ? " · " + (names[state.sheet] || state.sheet) + " open" : "");
  }
  function openHelp() {
    if (!state.user) return;
    state.help = { text: helpDraft, sending: false, sent: false, emailed: false, err: "" };
    renderHelp();
  }
  function closeHelp() {
    if (!state.help || state.help.sending) return;
    state.help = null; renderHelp();
    var b = document.getElementById("help-btn"); if (b && !b.hidden) b.focus();
  }
  function helpHtml() {
    var h = state.help;
    var head = '<div class="sheet-head"><div class="sheet-title"><h2 class="help-title">HELP · REPORT A PROBLEM</h2></div>' +
      '<button class="x" data-act="help-close" aria-label="Close"' + (h.sending ? " disabled" : "") + ">" + ICON.x + "</button></div>";
    if (h.sent) {
      return '<div class="scrim help-scrim" data-act="help-scrim"><div class="sheet help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-ask">' + head +
        '<div class="help-body" role="status"><div class="help-tick">' + ICON.check + "</div>" +
        '<h3 class="help-ask" id="help-ask">Thanks, report sent.</h3>' +
        '<p class="help-hint">' + (h.emailed ? "Anthony will get it by email and take a look." : "It's saved. Anthony will take a look.") + "</p>" +
        '<div class="help-btns"><button class="save ok help-send" data-act="help-close" id="help-done">DONE</button>' +
        '<button class="save alt help-send" data-act="help-again">REPORT SOMETHING ELSE</button></div></div></div></div>';
    }
    return '<div class="scrim help-scrim" data-act="help-scrim"><div class="sheet help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-ask">' + head +
      '<form class="help-body" id="help-form" novalidate>' +
      '<h3 class="help-ask" id="help-ask"><em>Found a bug?</em> Report it here:</h3>' +
      '<p class="help-hint">Tell us what you were doing and what went wrong. A sentence or two is plenty.</p>' +
      '<label for="help-what" class="help-sr">What went wrong</label>' +
      '<textarea id="help-what" maxlength="4000" placeholder="e.g. On 21758 I tapped Finish Catching and it said Not Saved."' + (h.sending ? " disabled" : "") + "></textarea>" +
      '<p class="help-err" id="help-err" role="alert">' + esc(h.err) + "</p>" +
      '<button type="submit" class="save help-send' + (h.sending ? " busy" : "") + '"' + (h.sending ? " disabled" : "") + ">" +
      (h.sending ? '<span class="spin"></span>SENDING…' : "SEND REPORT") + "</button></form></div></div>";
  }
  function renderHelp() {
    document.getElementById("help-btn").setAttribute("aria-expanded", state.help && state.user ? "true" : "false");
    if (!state.help || !state.user) { $help.innerHTML = ""; return; }
    $help.innerHTML = helpHtml();
    var t = document.getElementById("help-what");
    if (t) { t.value = state.help.text; if (!state.help.sending) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
    var d = document.getElementById("help-done"); if (d) d.focus();
  }
  function sendHelp() {
    var h = state.help;
    if (!h || h.sending) return;
    var t = document.getElementById("help-what");
    if (t) h.text = t.value;
    var text = h.text.trim();
    if (text.length < 5) { h.err = "Write a few words about what went wrong first."; renderHelp(); return; }
    h.err = ""; h.sending = true; renderHelp();
    api("POST", "/api/bug-report", { text: text, from: helpWhere(), screen: window.innerWidth + "×" + window.innerHeight, agent: navigator.userAgent })
      .then(function (r) {
        if (state.help !== h) return;            // closed by a sign-out meanwhile
        h.sending = false;
        if (r.ok && r.data && r.data.ok) {
          h.sent = true; h.emailed = !!r.data.emailed; h.text = ""; helpDraft = "";
        } else {
          h.err = r.status === 0 ? "No answer from the server, so it didn't send. Check the Wi-Fi and try again."
            : (r.data && r.data.message) || "That didn't send. Try again, or tell Anthony in person.";
        }
        renderHelp();
      });
  }

  /* ------------------------------------------------------------- saving -- */
  /* A save only goes out from a LIVE list. Anywhere else it's refused out loud, the form stays as
     it is, and the list is asked again at once so the catcher can tap save as soon as it's back. */
  var REFUSED = {
    stale: "This screen lost its connection and is showing the last data it had.",
    loading: "This screen is still loading.",
    error: "This screen is not connected to Salesforce."
  };
  function refuseSave(key) {
    var sc = state.scr[key], before = sc.s;
    showToast({ kind: "err", title: "NOT SAVED", body: REFUSED[before] + " Nothing was sent." + (before === "loading" ? "" : " Checking the connection now…") });
    if (before === "loading") return;
    loadList(key).then(function () {
      if (!state.user || state.saving) return;
      if (state.scr[key].s === "live") {
        renderOverlay();
        showToast({ kind: "ok", title: "SALESFORCE IS ANSWERING AGAIN", body: "Nothing was saved yet. Check your entries and tap save again." });
      } else if (state.toast && state.toast.title === "NOT SAVED") {
        state.toast.body = REFUSED[state.scr[key].s] + " Nothing was sent. Still offline; try again in a moment."; renderToast();
      }
    });
  }

  function send(kind, payload, opts) {
    if (state.saving) return;                 // a second tap does nothing
    var key = (kind === "edit" || kind === "del" || kind === "delmany") && state.mode === "past" ? "past" : "board";
    if (state.scr[key].s !== "live") { refuseSave(key); return; }
    opts = opts || {};
    state.saving = true; state.pending = { kind: kind, payload: payload, opts: opts };
    state.toast = null; renderToast(); renderOverlay();
    var path = { box: "/api/boxes", fin: "/api/finish", dup: "/api/duplicate-box", edit: "/api/box-edit", del: "/api/box-delete", delmany: "/api/box-delete-many", sz: "/api/size-change" }[kind] || "/api/misprints";
    api("POST", path, payload).then(function (r) {
      state.saving = false;
      if (!state.user) return;
      if (r.ok && (kind === "dup" || kind === "box") && r.data && r.data.error === "partial") {
        // Some copies exist, some don't: say exactly that, and never retry the whole batch.
        state.pending = null;
        var po = current();
        if (po) Array.prototype.push.apply(po.boxes, r.data.boxes || []);
        state.sheet = null; state.dup = null; state.box = null; renderOverlay(); renderMain();
        showToast({ kind: "err", title: r.data.created + (kind === "box" ? " SAVED · " : " CREATED · ") + r.data.failed + (kind === "box" ? " NOT SAVED" : " NOT CREATED"), body: r.data.message || "" });
        loadOrders();
        return;
      }
      if (r.ok) {
        state.pending = null;
        var o = current();
        if (kind === "edit" && o && r.data.box) {
          for (var ei = 0; ei < o.boxes.length; ei++) if (o.boxes[ei].id === r.data.box.id) o.boxes[ei] = r.data.box;
          showToast({ kind: "ok", title: "BOX UPDATED", body: "“" + r.data.box.name + "” on " + o.num + " is now " + r.data.box.type + " · " + (r.data.box.sizes || r.data.box.qty + " garments") + ". Confirmed by Salesforce (same box, same record)." });
        } else if (kind === "del" && o && r.data.deleted) {
          o.boxes = o.boxes.filter(function (x) { return x.id !== r.data.deleted.id; });
          showToast({ kind: "ok", title: "BOX DELETED", body: "“" + r.data.deleted.name + "” is deleted from " + o.num + " in Salesforce. " + (r.data.countNote || "") });
        } else if (kind === "delmany" && o && r.data.deleted) {
          var gone = {}; r.data.deleted.forEach(function (x) { gone[x.id] = true; });
          o.boxes = o.boxes.filter(function (x) { return !gone[x.id]; });
          var dn = r.data.deleted.length;
          showToast({ kind: "ok", title: dn + (dn === 1 ? " BOX DELETED" : " BOXES DELETED"), body: r.data.deleted.map(function (x) { return "“" + x.name + "”"; }).join(", ") + (dn === 1 ? " is" : " are") + " deleted from " + o.num + " in Salesforce. " + (r.data.countNote || "") });
          state.picking = null;
        } else if (kind === "dup" && o && r.data.boxes) {
          Array.prototype.push.apply(o.boxes, r.data.boxes);
          var bx = r.data.boxes, first = bx[0], last = bx[bx.length - 1];
          showToast({ kind: "ok", title: bx.length + (bx.length === 1 ? " BOX CREATED" : " BOXES CREATED"),
            body: (bx.length === 1 ? "“" + first.name + "”" : "“" + first.name + "” to “" + last.name + "”") + " · " + (first.sizes ? first.sizes.replace(/ = \d+$/, "") + " · " : "") + first.qty + " garments each · " + first.type + ". All confirmed by Salesforce on " + o.num + "." });
        } else if (kind === "box" && o && r.data.boxes && r.data.boxes.length > 1) {
          Array.prototype.push.apply(o.boxes, r.data.boxes);
          var mb = r.data.boxes, m1 = mb[0], m2 = mb[mb.length - 1];
          showToast({ kind: "ok", title: mb.length + " BOXES SAVED", body: "“" + m1.name + "” to “" + m2.name + "” · " + (m1.sizes ? m1.sizes.replace(/ = \d+$/, "") + " · " : "") + m1.qty + " garments each · " + m1.type + ". All confirmed by Salesforce on " + o.num + "." });
        } else if (kind === "box" && o && r.data.box) {
          o.boxes.push(r.data.box);
          showToast({ kind: "ok", title: "BOX SAVED", body: "“" + r.data.box.name + "” · " + (r.data.box.sizes ? r.data.box.sizes.replace(/ = \d+$/, "") + " · " : "") + r.data.box.qty + " garments · " + r.data.box.type + " is in Salesforce on " + o.num + "." });
        } else if (kind === "fin" && o) {
          o.finished = true; o.finishedCount = r.data.boxCount;
          if (r.data.countSaved === false) showToast({ kind: "unsure", title: "OFF THE BOARD · COUNT NOT SAVED", body: r.data.message || (o.num + ": the box count couldn't be written, but the boxes are saved.") });
          else if (r.data.fulfillment) showToast({ kind: "ok", title: "FULFILLMENT ORDER", body: o.num + ": Fulfillment order. No boxes. Saved in Salesforce." + (o.inProduction ? "" : " It's off your board now.") });
          else showToast({ kind: "ok", title: "ORDER FINISHED", body: o.num + ": " + r.data.boxCount + (r.data.boxCount === 1 ? " box" : " boxes") + " saved as the box count in Salesforce." + (o.inProduction ? "" : " It's off your board now.") });
          if (!o.inProduction) {
            state.orders = state.orders.filter(function (x) { return x.id !== o.id; });
            state.selId = state.orders.length ? state.orders[0].id : null; state.view = "list";
          }
        } else if (kind === "sz" && o) {
          if (r.data.order) for (var zi = 0; zi < state.orders.length; zi++) if (state.orders[zi].id === r.data.order.id) { state.orders[zi] = r.data.order; o = r.data.order; }
          var zl = o.lines[r.data.line != null ? r.data.line : (state.sz ? state.sz.line : 0)], zname = zl ? (zl.color ? zl.color + " " : "") + zl.product : "";
          if (r.data.unchanged) showToast({ kind: "ok", title: "NOTHING TO CHANGE", body: "Those sizes are already saved on " + o.num + "." });
          else if (r.data.cleared) showToast({ kind: "ok", title: "SIZES PUT BACK", body: zname + " on " + o.num + " is counted against the ordered sizes again. Removed from Size Changes in Salesforce." });
          else showToast({ kind: "ok", title: "SIZE CHANGE SAVED", body: zname + ": " + (r.data.pairs || []).map(function (p) { return p.size + " " + p.ordered + "→" + p.received; }).join(", ") + ". Saved to Size Changes on " + o.num + " in Salesforce." });
          state.sz = null;
        } else if (kind === "mis" && o && r.data.misprint) {
          o.misprintTotal = r.data.misprintTotal;
          var mp = r.data.misprint;
          // Where it went on the order's lines: that's what the Production Error screen shows (10-27).
          var where = mp.stored ? " Added to the " + mp.size + " line as " + mp.stored.field + " for the Production Error check."
            : mp.extra ? " " + mp.size + " is an extra size (not on the order), so it's in the notes only." : "";
          showToast({ kind: "ok", title: "MISPRINT SAVED", body: mp.qty + " × " + mp.size + " " + mp.garment + " · " + mp.reason + " is on " + o.num + "." + where + " The print shop has been notified." });
        }
        // Where the count went on The Forge's run results (11-12, preview site); one line under the toast.
        if (r.data && r.data.forgeNote && state.toast) { state.toast.body += " " + r.data.forgeNote; if (/^Saved on the Catch, but|still (show|count)/.test(r.data.forgeNote) && state.toast.kind === "ok") { state.toast.kind = "unsure"; clearTimeout(toastTimer); } }
        state.sheet = null; state.box = null; state.mis = null; state.fin = null; state.dup = null; state.del = null; state.delMany = null;
        if (kind === "box" && opts.andNew && o) {
          // SAVE BOX & NEW: only now that Salesforce has confirmed, open a fresh, blank box.
          state.box = newBox(o); state.sheet = "box";
        }
        renderOverlay(); renderMain(); renderToast();
        reloadAll();                           // pull the real records back from Salesforce, on both views
      } else if (r.status === 0 || (r.data && r.data.error === "unconfirmed") || (r.data && r.data.error === "in_progress")) {
        state.sheet = null; state.dup = null; state.del = null; state.delMany = null; if (kind === "delmany") state.picking = null; renderOverlay();
        showToast({ kind: "unsure", title: kind === "del" ? "NOT SURE IT DELETED" : kind === "delmany" ? "NOT SURE THEY DELETED" : "NOT SURE IT SAVED", body: (r.data && r.data.message) || "Check the order before trying again." });
        reloadAll();
      } else if (r.data && r.data.error === "org_changed") {
        // The preview site switched org while this form was open: nothing was saved; start over on the new org.
        orgChanged(r.data.org, r.data.orgLabel, false);
        showToast({ kind: "err", title: "NOT SAVED · SWITCHED TO " + String(r.data.orgLabel || r.data.org).toUpperCase(), body: r.data.message || "Nothing was saved." });
      } else if (r.status === 401) {
        // signedOut() already ran
      } else {
        renderOverlay();
        showToast({ kind: "err", title: "NOT SAVED", body: (r.data && r.data.message) || "Salesforce did not accept it. Nothing was saved.", retry: r.status >= 500 || r.status === 409 });
        if (r.data && /^(order_not_in_production|review_expired|box_not_found|changed|order_not_found)$/.test(r.data.error)) {
          // The box can't be changed any more (or changed under us): close, keep it visible, re-read from Salesforce.
          state.sheet = null; state.del = null; state.delMany = null; renderOverlay(); reloadAll();
          state.toast.title = r.data.error === "review_expired" ? "REVIEW PERIOD ENDED" : state.toast.title; state.toast.retry = false; renderToast();
        }
      }
    }).then(afterSave);
  }

  function saveBox(andNew) {
    var o = current(), b = state.box; if (!o || !b) return;
    var counts = boxCounts(o, b), total = boxTotal(o, b);
    var n = copiesN(b);
    if (!total || total > 9999 || !b.type || !n) return;
    var payload = { orderId: o.id, type: b.type, counts: counts, name: boxName(o, b), requestId: b.requestId };
    if (n > 1) payload.copies = n;
    send("box", payload, { andNew: !!andNew });
  }

  /** A fresh, blank box form (default Packaging Type, nothing counted, new one-time save id). */
  function newBox(o) {
    var def = state.boxTypes.filter(function (t) { return t.isDefault; })[0];
    var first = o && o.lines[0] && o.lines[0].sizes[0];
    return { type: def ? def.value : "", cells: {}, sel: first ? cellKey(0, first.size) : null, copies: "1", requestId: newRequestId() };
  }
  function saveMis() {
    var o = current(), m = state.mis; if (!o || !m || !m.size || !m.reason) return;
    var line = o.lines[m.line] || {};
    var garment = ((line.color ? line.color + " " : "") + (line.product || "")).trim().slice(0, 40);
    send("mis", { orderId: o.id, line: m.line, qty: m.qty, size: m.size, garment: garment, reason: m.reason, note: (m.note || "").trim(), requestId: m.requestId });
  }

  /* ------------------------------------------------------------- PIN ----- */
  function pinKey(k) {
    if (state.pinBusy) return;
    if (k === "C") state.pin = "";
    else if (k === "<") state.pin = state.pin.slice(0, -1);
    else if (state.pin.length < 4) state.pin += k;
    state.pinErr = "";
    renderMain();
    if (state.pin.length === 4) {
      state.pinBusy = true;
      // Signing in is one of the moments for the big loader: the PIN check, the setup and the
      // first order list each run inside foregroundLoad(), so they read as one loader.
      foregroundLoad(function () { return api("POST", "/api/login", { pin: state.pin }); }).then(function (r) {
        state.pinBusy = false;
        if (r.ok) {
          state.pin = ""; state.pinErr = ""; state.signoutMsg = "";
          foregroundLoad(loadSetup).then(function () {
            renderAll();
            var d = state.draft;
            if (d && state.user && d.user !== state.user.name) state.draft = null;   // never hand one catcher's entries to another
            foregroundLoad(function () { return d && d.mode === "past" ? Promise.all([loadOrders(), loadPast()]) : loadOrders(); }).then(restoreDraft);
          });
        } else {
          state.pin = ""; state.pinErr = (r.data && r.data.message) || "That PIN didn't work.";
          renderMain();
          var d = document.getElementById("dots"); if (d) d.classList.add("shake");
        }
      });
    }
  }

  /* --------------------------------------------------------- viewer ------ */
  var vz = { k: 1, x: 0, y: 0, ptrs: {}, pinch: null };
  function setupViewer() {
    vz = { k: 1, x: 0, y: 0, ptrs: {}, pinch: null };
    var stage = document.getElementById("stage");
    if (!stage) return;
    stage.addEventListener("pointerdown", function (e) {
      vz.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      var ids = Object.keys(vz.ptrs);
      if (ids.length === 2) { var a = vz.ptrs[ids[0]], b = vz.ptrs[ids[1]]; vz.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: vz.k }; }
    });
    stage.addEventListener("pointermove", function (e) {
      var p = vz.ptrs[e.pointerId]; if (!p) return;
      var ids = Object.keys(vz.ptrs);
      if (ids.length >= 2 && vz.pinch) {
        p.x = e.clientX; p.y = e.clientY;
        var a = vz.ptrs[ids[0]], b = vz.ptrs[ids[1]], r = stage.getBoundingClientRect();
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (vz.pinch.d > 0) zoomAt(vz.pinch.k * d / vz.pinch.d, (a.x + b.x) / 2 - r.left - r.width / 2, (a.y + b.y) / 2 - r.top - r.height / 2);
        return;
      }
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (vz.k > 1) { vz.x += dx; vz.y += dy; clampView(); paintView(); }
    });
    function up(e) { delete vz.ptrs[e.pointerId]; if (Object.keys(vz.ptrs).length < 2) vz.pinch = null; }
    stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up); stage.addEventListener("pointerleave", up);
    stage.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = stage.getBoundingClientRect();
      zoomAt(vz.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    }, { passive: false });
    stage.addEventListener("dblclick", function (e) {
      var r = stage.getBoundingClientRect();
      if (vz.k > 1.01) { vz.k = 1; vz.x = 0; vz.y = 0; paintView(); return; }
      zoomAt(2.5, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    });
    paintView();
  }
  function clampView() {
    var stage = document.getElementById("stage"), img = document.getElementById("v-img");
    if (!stage || !img) return;
    var maxX = Math.max(0, (img.offsetWidth * vz.k - stage.clientWidth) / 2 + 40);
    var maxY = Math.max(0, (img.offsetHeight * vz.k - stage.clientHeight) / 2 + 40);
    vz.x = Math.max(-maxX, Math.min(maxX, vz.x)); vz.y = Math.max(-maxY, Math.min(maxY, vz.y));
  }
  function zoomAt(target, fx, fy) {
    var k = Math.max(1, Math.min(6, target));
    if (k === 1) { vz.k = 1; vz.x = 0; vz.y = 0; paintView(); return; }
    var r = k / vz.k;
    vz.x = fx - (fx - vz.x) * r; vz.y = fy - (fy - vz.y) * r; vz.k = k;
    clampView(); paintView();
  }
  function paintView() {
    var img = document.getElementById("v-img"), stage = document.getElementById("stage"), pct = document.getElementById("v-pct");
    if (img) img.style.transform = "translate(" + vz.x + "px," + vz.y + "px) scale(" + vz.k + ")";
    if (stage) stage.classList.toggle("zoomed", vz.k > 1);
    if (pct) pct.textContent = Math.round(vz.k * 100) + "%";
  }

  /* --------------------------------------------------------- events ------ */
  var handlers = {
    pin: function (el) { pinKey(el.getAttribute("data-k")); },
    reload: function () { foregroundLoad(state.mode === "past" ? loadPast : loadOrders); },
    pick: function (el) {
      state.picking = null;
      if (state.mode === "past") state.pastSelId = el.getAttribute("data-id"); else state.selId = el.getAttribute("data-id");
      state.view = "detail"; renderMain();
    },
    "search-clear": function () {
      state.q = ""; applySearch();
      var i = document.getElementById("order-search"); if (i) { i.value = ""; i.focus(); }
      if (renderPending) renderMain();
    },
    mode: function (el) {
      state.picking = null;
      var m = el.getAttribute("data-m"); if (m === state.mode) return;
      state.mode = m; state.view = "list"; state.q = ""; renderMain(); paintConn();
      // A list's FIRST load gets the big loader; one already on screen refreshes quietly (corner icon).
      var load = m === "past" ? loadPast : loadOrders;
      if (state.scr[m].s === "loading") foregroundLoad(load); else load();
    },
    "open-edit": function (el) {
      var o = current(); if (!o) return;
      var b = o.boxes.filter(function (x) { return x.id === el.getAttribute("data-id"); })[0];
      if (!b || !canChangeBox(withWindow(b))) { showToast({ kind: "err", title: "REVIEW PERIOD ENDED", body: "This box is past its 7-day review period, so it can't be changed." }); return; }
      var cells = {}, orig = {};
      var added = {};
      (b.counts || []).forEach(function (c) {
        var k = cellKey(c.line, c.size); cells[k] = String(c.qty); orig[k] = c.qty;
        if (c.extra) { (added[c.line] = added[c.line] || []).push(c.size); }
      });
      var first = (b.counts && b.counts[0]) ? cellKey(b.counts[0].line, b.counts[0].size) : (o.lines[0] && o.lines[0].sizes[0] ? cellKey(0, o.lines[0].sizes[0].size) : null);
      var word0 = garmentWordOf(b.name), num = (String(b.name).match(/\s(\d+)$/) || [])[1] || "";
      state.box = { type: b.type, cells: cells, sel: first, requestId: newRequestId(), word: word0, added: added,
        edit: { boxId: b.id, name0: b.name, word0: word0, num: num, at: b.at, until: b.editableUntil, orig: orig, hadSizes: !!(b.counts && b.counts.length), qty0: b.qty } };
      state.sheet = "box"; state.toast = null; renderToast(); renderOverlay();
    },
    "box-word": function (el) { if (state.box) { state.box.word = el.getAttribute("data-v"); renderOverlay(); } },
    "save-edit": function () {
      var o = current(), b = state.box; if (!o || !b || !b.edit) return;
      var total = boxTotal(o, b); if (!total || total > 9999 || !b.type || !b.word) return;
      send("edit", { orderId: o.id, boxId: b.edit.boxId, type: b.type, word: b.word, counts: boxCounts(o, b), requestId: b.requestId });
    },
    "open-del": function (el) {
      var o = current(); if (!o) return;
      var b = o.boxes.filter(function (x) { return x.id === el.getAttribute("data-id"); })[0];
      if (!b || !canChangeBox(withWindow(b))) { showToast({ kind: "err", title: "REVIEW PERIOD ENDED", body: "This box is past its 7-day review period, so it can't be deleted." }); return; }
      state.del = { boxId: b.id, requestId: newRequestId() };
      state.sheet = "del"; state.toast = null; renderToast(); renderOverlay();
    },
    "sz-open": function (el) { var o = current(); if (o && !state.saving) openSizes(o, parseInt(el.getAttribute("data-i"), 10) || 0); },
    "sz-cell": function (el) { var z = state.sz; if (!z) return; var k = el.getAttribute("data-k"); if (z.sel !== k) z.fresh = true; z.sel = k; renderOverlay(); },
    "sz-key": function (el) {
      var z = state.sz; if (!z || !z.sel) return;
      var k = el.getAttribute("data-k"), v = z.vals[z.sel] || "";
      if (z.fresh) { v = ""; z.fresh = false; }          // the first digit replaces what was there
      if (k === "C") v = ""; else if (k === "<") v = v.slice(0, -1); else if (v.length < 4) v = (v === "0" ? "" : v) + k;
      z.vals[z.sel] = v; renderOverlay();
    },
    "sz-next": function () {
      var o = current(), z = state.sz; if (!o || !z) return;
      var sizes = o.lines[z.line].sizes.map(function (s) { return s.size; }), i = sizes.indexOf(z.sel);
      z.sel = sizes[(i + 1) % sizes.length]; z.fresh = true; renderOverlay();
    },
    "sz-save": function () {
      var o = current(), z = state.sz; if (!o || !z) return;
      var received = {};
      o.lines[z.line].sizes.forEach(function (s) { var v = z.vals[s.size]; if (v !== "" && v != null) received[s.size] = parseInt(v, 10); });
      send("sz", { orderId: o.id, line: z.line, received: received, note: z.note.trim(), requestId: z.requestId });
    },
    "pick-start": function () {
      var o = current(); if (!o || state.saving) return;
      state.picking = { orderId: o.id, ids: {} }; renderMain();
    },
    "pick-cancel": function () { state.picking = null; renderMain(); },
    "pick-all": function () {
      var o = current(), pk = pickingFor(o); if (!pk) return;
      var can = pickable(o), all = can.length && pickedBoxes(o).length === can.length;
      pk.ids = {}; if (!all) can.forEach(function (b) { pk.ids[b.id] = true; });
      renderMain();
    },
    "pick-box": function (el) {
      var o = current(), pk = pickingFor(o), id = el.getAttribute("data-id"); if (!pk || !id) return;
      if (pk.ids[id]) delete pk.ids[id]; else pk.ids[id] = true;
      renderMain();
    },
    "pick-delete": function () {
      var o = current(), picked = pickedBoxes(o); if (!o || !picked.length) return;
      state.delMany = { ids: picked.map(function (b) { return b.id; }), requestId: newRequestId() };
      state.sheet = "delmany"; state.toast = null; renderToast(); renderOverlay();
    },
    "delmany-confirm": function () {
      var o = current(), d = state.delMany; if (!o || !d) return;
      send("delmany", { orderId: o.id, boxIds: d.ids, requestId: d.requestId });
    },
    "del-confirm": function () {
      var o = current(), d = state.del; if (!o || !d) return;
      send("del", { orderId: o.id, boxId: d.boxId, requestId: d.requestId });
    },
    back: function () { state.view = "list"; applyZoom(); },
    mock: function () { state.mockIdx = 0; state.sheet = "mock"; renderOverlay(); },
    "v-prev": function () { state.mockIdx = Math.max(0, (state.mockIdx || 0) - 1); renderOverlay(); },
    "v-next": function () { var o = current(); state.mockIdx = Math.min(((o && o.mockupCount) || 1) - 1, (state.mockIdx || 0) + 1); renderOverlay(); },
    "open-box": function () {
      if (!state.boxTypes.length) api("GET", "/api/box-types").then(function (r) { if (r.ok) { state.boxTypes = r.data.types || []; renderOverlay(); } });
      state.box = newBox(current());
      state.sheet = "box"; state.toast = null; renderToast(); renderOverlay();
    },
    "open-mis": function () {
      state.mis = { line: 0, size: null, qty: 1, reason: null, note: "", requestId: newRequestId() };
      state.sheet = "mis"; state.toast = null; renderToast(); renderOverlay();
    },
    close: function () { if (state.saving) return; state.sheet = null; state.delMany = null; state.sz = null; renderOverlay(); },
    "box-type": function (el) { state.box.type = el.getAttribute("data-v"); renderOverlay(); },
    "box-cell": function (el) {
      var k = el.getAttribute("data-k");
      if (k === "copies" && state.box.sel !== "copies") state.box.copiesFresh = true;
      state.box.sel = k; renderOverlay();
    },
    "add-more": function (el) {
      var b = state.box; if (!b) return;
      var li = Number(el.getAttribute("data-i"));
      b.adding = b.adding && b.adding.line === li ? null : { line: li, text: "" };
      renderOverlay();
    },
    "add-size": function (el) { addExtra(Number(el.getAttribute("data-i")), el.getAttribute("data-v")); },
    "add-other": function () {
      var b = state.box; if (!b || !b.adding) return;
      var inp = document.getElementById("extra-size");
      addExtra(b.adding.line, inp ? inp.value : b.adding.text);
    },
    "add-cancel": function () { if (state.box) { state.box.adding = null; renderOverlay(); } },
    "box-key": function (el) {
      var b = state.box; if (!b.sel) return;
      if (b.sel === "copies") {
        var kc = el.getAttribute("data-k"), vc = b.copies == null ? "1" : String(b.copies);
        if (b.copiesFresh) { vc = ""; b.copiesFresh = false; }   // the first digit replaces the 1
        if (kc === "C") vc = ""; else if (kc === "<") vc = vc.slice(0, -1); else if (vc.length < 3) vc = (vc === "0" ? "" : vc) + kc;
        b.copies = vc; renderOverlay(); return;
      }
      var k = el.getAttribute("data-k"), v = b.cells[b.sel] || "";
      if (k === "C") v = ""; else if (k === "<") v = v.slice(0, -1); else if (v.length < 4) v = (v === "0" ? "" : v) + k;
      b.cells[b.sel] = v; renderOverlay();
    },
    "box-rest": function () {
      var o = current(), b = state.box; if (!o || !b.sel) return;
      var p = b.sel.split("|"), line = o.lines[Number(p[0])], size = p.slice(1).join("|");
      var s = line && line.sizes.filter(function (x) { return x.size === size; })[0];
      if (!s) return;
      var rest = Math.max(0, sizeLeft(s)); b.cells[b.sel] = rest ? String(rest) : ""; renderOverlay();
    },
    "box-next": function () {
      var o = current(), b = state.box; if (!o || !b.sel) return;
      var all = [];
      o.lines.forEach(function (l, li) {
        l.sizes.forEach(function (s) { all.push(cellKey(li, s.size)); });
        extrasFor(o, b, li).forEach(function (sz) { all.push(cellKey(li, sz)); });
      });
      var i = all.indexOf(b.sel); b.sel = all[(i + 1) % all.length]; renderOverlay();
    },
    "save-box": function () { saveBox(false); },
    "save-box-new": function () { saveBox(true); },
    "open-dup": function (el) {
      var o = current(); if (!o) return;
      var src = o.boxes.filter(function (b) { return b.id === el.getAttribute("data-id"); })[0];
      if (!src) return;
      state.dup = { boxId: src.id, n: "1", requestId: newRequestId() };
      state.sheet = "dup"; state.toast = null; renderToast(); renderOverlay();
    },
    "dup-key": function (el) {
      if (state.saving || !state.dup) return;
      var k = el.getAttribute("data-k"), v = state.dup.n || "";
      if (k === "C") v = ""; else if (k === "<") v = v.slice(0, -1); else if (v.length < 3) v = (v === "0" ? "" : v) + k;
      state.dup.n = v; renderOverlay();
    },
    "dup-step": function (el) {
      if (state.saving || !state.dup) return;
      var n = (parseInt(state.dup.n || "0", 10) || 0) + Number(el.getAttribute("data-d"));
      state.dup.n = String(Math.max(1, Math.min(MAX_DUP, n))); renderOverlay();
    },
    "dup-confirm": function () {
      var o = current(), d = state.dup; if (!o || !d) return;
      var n = dupCount(d.n); if (!n) return;
      send("dup", { orderId: o.id, boxId: d.boxId, count: n, requestId: d.requestId });
    },
    "open-fin": function () {
      var o = current(); if (!o || !o.boxes.length) return;
      state.fin = { requestId: newRequestId() };
      state.sheet = "fin"; state.toast = null; renderToast(); renderOverlay();
    },
    "open-ful": function () {
      var o = current(); if (!o || o.boxes.length) return;
      state.fin = { requestId: newRequestId(), fulfillment: true };
      state.sheet = "fin"; state.toast = null; renderToast(); renderOverlay();
    },
    "save-fin": function () {
      var o = current(); if (!o || !state.fin) return;
      var p = { orderId: o.id, requestId: state.fin.requestId };
      if (state.fin.fulfillment) p.fulfillment = true;
      send("fin", p);
    },
    "mis-line": function (el) { state.mis.line = Number(el.getAttribute("data-i")); state.mis.size = null; renderOverlay(); },
    "mis-size": function (el) { state.mis.size = el.getAttribute("data-v"); renderOverlay(); },
    "mis-reason": function (el) { state.mis.reason = el.getAttribute("data-v"); renderOverlay(); },
    "mis-minus": function () { state.mis.qty = Math.max(1, state.mis.qty - 1); renderOverlay(); },
    "mis-plus": function () { state.mis.qty = Math.min(99, state.mis.qty + 1); renderOverlay(); },
    "save-mis": saveMis,
    retry: function () { if (state.pending) { var p = state.pending; state.pending = null; send(p.kind, p.payload, p.opts); } },
    dismiss: function () { clearTimeout(toastTimer); state.toast = null; renderToast(); },
    "v-in": function () { zoomAt(vz.k * 1.5, 0, 0); },
    "v-out": function () { zoomAt(vz.k / 1.5, 0, 0); },
    "v-fit": function () { vz.k = 1; vz.x = 0; vz.y = 0; paintView(); }
  };

  handlers["help-close"] = closeHelp;
  handlers["orgsw-close"] = closeOrgSw;
  handlers["orgsw-pick"] = function (el) { if (state.orgsw && !state.orgsw.busy) { state.orgsw.pick = el.getAttribute("data-v"); state.orgsw.err = ""; renderOrgSw(); } };
  handlers["orgsw-key"] = function (el) {
    var w = state.orgsw; if (!w || w.busy) return;
    var k = el.getAttribute("data-k");
    if (k === "C") w.pin = ""; else if (k === "<") w.pin = w.pin.slice(0, -1); else if (w.pin.length < 8) w.pin += k;
    w.err = ""; renderOrgSw();
  };
  handlers["orgsw-go"] = orgSwGo;
  handlers["help-again"] = function () { if (state.help) { state.help = { text: "", sending: false, sent: false, emailed: false, err: "" }; renderHelp(); } };
  document.addEventListener("click", function (e) {
    // Help pop-up: a tap on the dimmed area outside it closes it (what was typed is kept).
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-act") === "help-scrim") { closeHelp(); return; }
    var el = e.target.closest ? e.target.closest("[data-act]") : null;
    if (el && el.getAttribute("data-act") === "help-scrim") el = null;
    if (!el || el.disabled) return;
    var fn = handlers[el.getAttribute("data-act")];
    if (fn) fn(el);
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "mis-note" && state.mis) state.mis.note = e.target.value.slice(0, 80);
    if (e.target && e.target.id === "sz-note" && state.sz) {
      state.sz.note = e.target.value.slice(0, 200);
      var sb = document.querySelector("[data-act=sz-save]"), o2 = current();   // only the button changes while typing
      if (sb && o2) { var sv = szSaveLabel(o2); sb.disabled = !sv.ready; sb.innerHTML = sv.label; }
    }
    if (e.target && e.target.id === "extra-size" && state.box && state.box.adding) state.box.adding.text = e.target.value.slice(0, 10);
    if (e.target && e.target.id === "order-search") { state.q = e.target.value.slice(0, 60); applySearch(); }
    if (e.target && e.target.id === "help-what" && state.help) {
      state.help.text = helpDraft = e.target.value.slice(0, 4000);
      if (state.help.err) { state.help.err = ""; var er = document.getElementById("help-err"); if (er) er.textContent = ""; }
    }
  });
  document.addEventListener("submit", function (e) {
    if (e.target && e.target.id === "help-form") { e.preventDefault(); sendHelp(); }
  });
  // Leaving the search box: catch up on any refresh that waited while typing; "Done" closes the keyboard.
  document.addEventListener("focusout", function (e) {
    if (e.target && e.target.id === "order-search" && renderPending) setTimeout(function () { if (renderPending) renderMain(); }, 600);   // after a tap on a card has landed
  });
  document.addEventListener("keydown", function (e) {
    if (e.target && e.target.id === "order-search" && e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    if (e.target && e.target.id === "extra-size" && e.key === "Enter" && state.box && state.box.adding) { e.preventDefault(); addExtra(state.box.adding.line, e.target.value); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.help) { closeHelp(); return; }
    if (e.key === "Escape" && state.orgsw) { closeOrgSw(); return; }
    if (e.key === "Escape" && state.sheet && !state.saving) { state.sheet = null; state.delMany = null; state.sz = null; renderOverlay(); return; }
    if (e.key === "Escape" && state.picking && !state.saving) { state.picking = null; renderMain(); return; }
    if ((e.key === " " || e.key === "Enter") && e.target && e.target.getAttribute && e.target.getAttribute("data-act") === "pick-box") { e.preventDefault(); handlers["pick-box"](e.target); }
  });
  document.getElementById("help-btn").addEventListener("click", function () { if (state.help) closeHelp(); else openHelp(); });
  document.getElementById("org-chip").addEventListener("click", function () { if (state.orgsw) closeOrgSw(); else openOrgSw(); });
  document.getElementById("zoom-in").addEventListener("click", function () { stepZoom(1); });
  document.getElementById("zoom-out").addEventListener("click", function () { stepZoom(-1); });
  document.getElementById("zoom-reset").addEventListener("click", function () { state.zoom = 1; saveZoom(1); applyZoom(); });
  document.getElementById("who").addEventListener("click", function () {
    if (state.saving) return;
    doLogout("manual");
  });
  window.addEventListener("resize", applyZoom);
  window.addEventListener("beforeunload", function (e) { if (state.saving) { e.preventDefault(); e.returnValue = ""; } });
  // Refreshes pause while the tablet's screen is off or the app is in the background;
  // coming back to the front refreshes straight away.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !state.user) return;
    keepAwake();
    if (!state.sheet && !state.saving && scrNow().s !== "loading") { if (state.mode === "past") loadPast(); else loadOrders(); }
  });

  function tickClock() {
    document.getElementById("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (state.user && scrNow().s === "stale") paintConn();   // keeps "Offline · N m old" counting
  }
  setInterval(tickClock, 15000); tickClock();
  /* One timer per list. On each tick: skip silently while someone is in the middle of something
     (any form, dialog or the mockup viewer is open, or a save is on its way -- a redraw underneath
     would swap what they're reading), else ask shouldPoll() and only then reload in the background. */
  function pollTick(key) {
    if (!state.user || document.hidden || state.mode !== key) return;
    if (state.sheet || state.saving) return;
    if (shouldPoll(state.scr[key])) loadList(key);
  }
  setInterval(function () { pollTick("board"); }, POLL_MS.board);
  setInterval(function () { pollTick("past"); }, POLL_MS.past);

  /* ------------------------------------------------------------ start ---- */
  applyZoom();
  // A refresh (any page load) signs out: end any earlier sign-in on the server, then show the PIN pad.
  api("POST", "/api/logout").then(function () {
    renderAll(); paintConn();
    loadOrg();   // which Salesforce this site is on (preview: shown on the PIN screen and in the header)
  });
})();
