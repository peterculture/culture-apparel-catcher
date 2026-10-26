/* Dryer Catch — tablet app for the catchers at the end of the screen-print dryers.
 *
 * Plain JavaScript, no build step. Everything the catcher sees comes from
 * /api/*, which talks to Salesforce. Nothing is ever shown as "saved" until
 * the server says Salesforce confirmed it.
 */
(function () {
  "use strict";

  var ZOOMS = [0.85, 1, 1.15, 1.3, 1.5, 1.75];
  var POLL_MS = 30000;

  var state = {
    user: null,            // { name }
    reasons: [],
    boxTypes: [],
    orders: [],
    loaded: false,
    loadError: "",
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
    past: [], pastLoaded: false, pastError: "", pastSelId: null,
    del: null,             // { boxId, requestId } while the Delete Box dialog is open
    logoutPending: null,   // a logout waiting for a save that's already on its way to Salesforce
    draft: null,           // an unsaved form kept for the SAME catcher after an automatic sign-out
    signoutMsg: ""
  };

  var $app = document.getElementById("app");
  var $overlay = document.getElementById("overlay");
  var $toast = document.getElementById("toast");
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
  /** "Tees", "Hats", "Hoodies"... — the word the shop already uses in box names. */
  function shortFor(product) {
    var p = String(product || "");
    if (/beanie/i.test(p)) return "Beanies";
    if (/\bhat\b|\bcap\b|trucker|snapback|richardson/i.test(p)) return "Hats";
    if (/hood/i.test(p)) return "Hoodies";
    if (/crew|sweat|fleece/i.test(p)) return "Crewnecks";
    if (/polo/i.test(p)) return "Polos";
    if (/tank/i.test(p)) return "Tanks";
    if (/long ?sleeve|\bl\/?s\b/i.test(p)) return "Long Sleeves";
    if (/tote|bag/i.test(p)) return "Bags";
    return "Tees";
  }
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
    x: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>',
    box: '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>',
    warn: '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>',
    expand: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    check: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    bang: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 6v8M12 18v.01"/></svg>',
    shirt: '<svg width="70%" height="70%" viewBox="0 0 48 48" aria-hidden="true"><path d="M17 8 L9 12 L5 20 L10 23 L13 19 L13 41 L35 41 L35 19 L38 23 L43 20 L39 12 L31 8 Q24 13 17 8 Z" fill="#2a2a30" stroke="#4a4a52" stroke-width="1.2"/></svg>'
  };

  /* ---------------------------------------------------------------- api -- */
  function api(method, path, body) {
    var write = method !== "GET";
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, write ? 35000 : 20000) : null;
    return fetch(path, {
      method: method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
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
    });
  }

  function setConn(kind) {
    var dot = document.getElementById("conn-dot"), label = document.getElementById("conn-label");
    dot.className = kind === "live" ? "live" : kind === "down" ? "down" : "";
    label.textContent = kind === "live" ? "Live" : kind === "down" ? "Not connected" : "Connecting";
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
    state.orders = []; state.loaded = false; state.loadError = ""; state.selId = null;
    state.past = []; state.pastLoaded = false; state.pastError = ""; state.pastSelId = null;
    state.sheet = null; state.box = null; state.mis = null; state.dup = null; state.del = null; state.fin = null;
    state.pending = null; state.saving = false; state.pin = ""; state.pinErr = ""; state.mode = "board"; state.view = "list";
    clearTimeout(toastTimer); state.toast = null;
    state.signoutMsg = reason === "expired" ? "Your sign-in ended." : "";
    if (state.draft) state.signoutMsg += " " + state.draft.user + "'s unsaved entries on " + state.draft.num + " are kept and reopen when " + firstName(state.draft.user) + " signs in again.";
    $overlay.removeAttribute("data-shown");
    renderAll(); setConn("");
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
  function loadOrders(quiet) {
    if (!state.user) return Promise.resolve();
    if (!quiet) setConn("");
    return api("GET", "/api/orders").then(function (r) {
      if (!state.user) return;
      if (r.ok && Array.isArray(r.data.orders)) {
        state.orders = r.data.orders;
        state.loaded = true;
        state.loadError = "";
        if (!findIn(state.orders, state.selId)) state.selId = state.orders.length ? state.orders[0].id : null;
        dropOldMocks();
        setConn("live");
      } else {
        // Keep showing what we had; say plainly that it may be out of date.
        state.loadError = (r.data && r.data.message) || "Could not load orders.";
        setConn("down");
      }
      if (!state.sheet) renderMain();
    });
  }

  /** Past Orders: boxed orders from the last 30 days, read fresh from Salesforce. */
  function loadPast(quiet) {
    if (!state.user) return Promise.resolve();
    if (!quiet) setConn("");
    return api("GET", "/api/past-orders").then(function (r) {
      if (!state.user) return;
      if (r.ok && Array.isArray(r.data.orders)) {
        state.past = r.data.orders; state.pastLoaded = true; state.pastError = "";
        if (!findIn(state.past, state.pastSelId)) state.pastSelId = state.past.length ? state.past[0].id : null;
        setConn("live");
      } else {
        state.pastError = (r.data && r.data.message) || "Could not load past orders.";
        setConn("down");
      }
      if (!state.sheet && state.mode === "past") renderMain();
    });
  }
  function reloadAll() { loadOrders(true); loadPast(true); }

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
      if (rs[0].ok) { state.user = { name: rs[0].data.name }; state.reasons = rs[0].data.reasons || []; keepAwake(); }
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
    renderMain(); renderOverlay(); renderToast(); applyZoom();
  }

  function renderMain() {
    if (!state.user) { $app.innerHTML = pinHtml(); return; }
    // While someone is typing in the search box, a background refresh waits until they leave the
    // box, so the keyboard doesn't close mid-word. (Tapping anything else leaves the box first.)
    var a = document.activeElement;
    if (a && a.id === "order-search") { renderPending = true; return; }
    renderPending = false;
    $app.innerHTML = listHtml() + detailHtml();
    applySearch();
    wireImages();
    applyZoom();
  }

  /* ------------------------------------------------------------ search --- */
  var renderPending = false;
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
    return fetch("/api/mockup?orderId=" + encodeURIComponent(parts[0]) + "&n=" + (parseInt(parts[1], 10) || 0), { credentials: "same-origin" }).then(function (resp) {
      if (resp.status === 401) { signedOut(); return null; }
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error("mockup " + resp.status);
      var type = (resp.headers.get("Content-Type") || "").split(";")[0].trim();
      return resp.arrayBuffer().then(function (buf) {
        if (/^image\//.test(type)) return new Blob([buf], { type: type });
        if (type === "application/pdf") return pdfToPicture(buf);
        throw new Error("mockup type " + type);
      });
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
    return '<div class="pin-wrap ca-season-pin"><div class="pin-box">' + seasonChip(false) +
      "<h1>WHO'S CATCHING?</h1><p>Enter your 4-digit PIN</p>" +
      (state.signoutMsg ? '<div class="pin-note">' + esc(state.signoutMsg) + "</div>" : "") +
      '<div class="dots" id="dots">' + dots + "</div>" +
      '<div class="pin-err" id="pin-err">' + esc(state.pinErr || "") + "</div>" +
      '<div class="pin-pad">' + keys + "</div></div></div>";
  }

  function modeTabs() {
    return '<div class="mode-tabs" role="tablist">' +
      '<button role="tab" data-act="mode" data-m="board" aria-selected="' + (state.mode === "board") + '">IN PRODUCTION <span>' + state.orders.length + "</span></button>" +
      '<button role="tab" data-act="mode" data-m="past" aria-selected="' + (state.mode === "past") + '">PAST ORDERS</button></div>';
  }

  function pastListHtml() {
    var cards = state.past.map(function (o) {
      var open = o.boxes.filter(canChangeBox).length;
      var tag = open ? '<span class="tag edit">' + open + (open === 1 ? " BOX" : " BOXES") + " EDITABLE</span>" : '<span class="tag lock">READ-ONLY · PAST 7 DAYS</span>';
      return '<button class="card" data-act="pick" data-id="' + esc(o.id) + '" data-q="' + esc(searchKey(o)) + '" aria-pressed="' + (o.id === state.pastSelId) + '">' +
        '<span class="thumb">' + ICON.box + "</span>" +
        '<span class="card-body"><span class="card-num">' + esc(o.num) + "</span>" +
        '<span class="card-cust">' + esc(o.customer) + "</span>" +
        '<span class="card-meta">' + o.boxes.length + (o.boxes.length === 1 ? " box" : " boxes") + (o.lastBoxAt ? " · last box " + esc(fmtDate(o.lastBoxAt)) + " " + esc(fmtTime(o.lastBoxAt)) : "") + "</span>" + tag + "</span></button>";
    }).join("");
    var body;
    if (!state.pastLoaded && state.pastError) body = '<div class="empty"><strong>COULDN\'T LOAD PAST ORDERS</strong>' + esc(state.pastError) + '<br><button class="back" data-act="reload">TRY AGAIN</button></div>';
    else if (!state.pastLoaded) body = '<div class="empty">Loading past orders…</div>';
    else if (!state.past.length) body = '<div class="empty"><strong>NO BOXES IN THE LAST 30 DAYS</strong>Screen-print orders show here once boxes are logged on them.</div>';
    else body = (state.pastError ? '<div class="empty" style="margin-bottom:0"><strong>MAY BE OUT OF DATE</strong>' + esc(state.pastError) + "</div>" : "") + '<div class="cards">' + cards + "</div>";
    return '<section class="list" aria-label="Past orders">' + modeTabs() +
      '<div class="list-head ca-season-head"><div class="list-title"><h1>PAST ORDERS</h1><span class="list-count">' + state.past.length + "</span></div>" +
      '<div class="list-sub"><i></i>BOXES FROM THE LAST 30 DAYS · EDIT OR DELETE FOR 7 DAYS</div>' + seasonChip(true) + "</div>" + (state.past.length ? searchBoxHtml() : "") + body + "</section>";
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
        '<span class="card-body"><span class="card-num">' + esc(o.num) + "</span>" +
        '<span class="card-cust">' + esc(o.customer) + "</span>" +
        progressHtml(o) + tag + "</span></button>";
    }).join("");
    var body;
    if (!state.loaded && state.loadError) {
      body = '<div class="empty"><strong>COULDN\'T LOAD ORDERS</strong>' + esc(state.loadError) +
        '<br><button class="back" data-act="reload">TRY AGAIN</button></div>';
    } else if (!state.loaded) {
      body = '<div class="empty">Loading orders…</div>';
    } else if (!state.orders.length) {
      body = '<div class="empty"><strong>NOTHING IN PRODUCTION</strong>No screen-print orders are marked In Production right now. This list refreshes on its own.</div>';
    } else {
      body = (state.loadError ? '<div class="empty" style="margin-bottom:0"><strong>MAY BE OUT OF DATE</strong>' + esc(state.loadError) + "</div>" : "") +
        '<div class="cards">' + cards + "</div>";
    }
    return '<section class="list" aria-label="Orders in production">' + modeTabs() +
      '<div class="list-head ca-season-head"><div class="list-title"><h1>IN PRODUCTION</h1><span class="list-count">' + state.orders.length + "</span></div>" +
      '<div class="list-sub"><i></i>SCREEN PRINT ONLY</div>' + seasonChip(true) + "</div>" + (state.orders.length ? searchBoxHtml() : "") + body + "</section>";
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
    var o = current();
    if (!o) return '<main class="detail"><div class="empty">Pick an order on the left.</div></main>';
    if (state.mode === "past") return pastDetailHtml(o);
    var split = boxedSplit(o), boxed = split.ordered;
    var mock = o.hasMockup
      ? '<button class="mock" data-act="mock" data-id="' + esc(o.id) + '" aria-label="Open the mockup full size"><img class="mock-img" alt="Mockup for ' + esc(o.num) + '" data-mock="' + esc(o.id) + ':0"><span class="mock-wait mock-none">LOADING<br>MOCKUP…</span><span class="badge">' + ICON.expand + '</span><span class="cap">' + ((o.mockupCount || 1) > 1 ? "TAP TO SEE ALL " + o.mockupCount : "TAP TO ENLARGE") + '</span></button>'
      : '<div class="mock"><span class="mock-none">NO MOCKUP<br>IN SALESFORCE</span></div>';
    var lines = o.lines.map(function (l) {
      return '<div><div class="line-head"><span>' + esc(l.product) + (l.color ? " · " + esc(l.color) : "") + '</span><span class="tot">' + l.total + "</span></div>" +
        '<div class="sizes">' + l.sizes.map(function (s) {
          return '<div class="size"><div class="s">' + esc(s.size) + '</div><div class="q">' + s.qty + "</div></div>";
        }).join("") + (l.extras || []).map(function (e) {
          return '<div class="size extra" title="Extra: not on the order"><div class="s">' + esc(e.size) + ' · EXTRA</div><div class="q">+' + e.boxed + "</div></div>";
        }).join("") + "</div></div>";
    }).join("");
    var log = boxRowsHtml(o, true);
    var misLog = o.misprintNotes ? '<div class="sec-label" style="margin-top:.6rem">MISPRINT NOTES IN SALESFORCE</div><div class="notes">' + esc(o.misprintNotes.split(" | ").join("\n")) + "</div>" : "";
    var banner = o.inProduction ? "" : '<div class="moved-banner">' + ICON.warn +
      "<div><b>MOVED TO " + esc(String(o.status || "Post-Production").toUpperCase()) + "</b>The print crew moved this order on. Finish logging its boxes, then tap FINISH CATCHING. It stays on your board until you do.</div></div>";
    return '<main class="detail">' +
      '<button class="back narrow-only" data-act="back">' + ICON.back + "ALL ORDERS</button>" + banner +
      '<div class="d-top">' + mock + '<div class="d-id"><h2 class="d-num">' + esc(o.num) + "</h2>" +
      '<div class="d-cust">' + esc(o.customer) + "</div>" +
      '<div class="d-meta">Print date ' + esc(fmtDate(o.printDate)) + (o.specs ? " · " + esc(o.specs) : "") + "</div></div></div>" +
      '<div class="panel">' + (lines || '<div class="hint">No garment sizes on this order in Salesforce.</div>') + "</div>" +
      '<div class="stats"><div class="stat"><div class="l">BOXES</div><div class="v">' + o.boxes.length + "</div></div>" +
      '<div class="stat"><div class="l">BOXED</div><div class="v">' + boxed + " <small>/ " + o.total + (split.extra ? " · +" + split.extra + " extra" : "") + "</small></div></div>" +
      '<div class="stat"><div class="l">MISPRINTS</div><div class="v' + (o.misprintTotal ? " warn" : "") + '">' + o.misprintTotal + "</div></div></div>" +
      '<div class="actions"><button class="big big-red" data-act="open-box">' + ICON.box + "LOG BOXES</button>" +
      '<button class="big big-warn" data-act="open-mis">' + ICON.warn + "REPORT MISPRINT</button></div>" +
      finishBtn(o) +
      '<div class="log"><div class="sec-label">BOXES ON THIS ORDER</div>' +
      (log || '<div class="empty" style="margin:0">No boxes logged yet.</div>') + misLog + "</div>" +
      "</main>";
  }

  /** Saved boxes, with Duplicate (board only), Edit and Delete -- or a lock once the 7 days are up. */
  function boxRowsHtml(o, onBoard) {
    return o.boxes.map(function (b, i) {
      withWindow(b);
      var open = canChangeBox(b);
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
      '<div class="d-cust">' + esc(o.customer) + "</div>" +
      '<div class="d-meta">Print date ' + esc(fmtDate(o.printDate)) + " · " + esc(where) + (o.finished ? " · Packaging Count " + o.finishedCount : "") + "</div></div></div>" +
      '<div class="stats"><div class="stat"><div class="l">BOXES</div><div class="v">' + o.boxes.length + "</div></div>" +
      '<div class="stat"><div class="l">BOXED</div><div class="v">' + boxed + " <small>/ " + o.total + (split.extra ? " · +" + split.extra + " extra" : "") + "</small></div></div>" +
      '<div class="stat"><div class="l">EDITABLE</div><div class="v">' + open + "</div></div></div>" +
      '<div class="log"><div class="sec-label">BOXES ON THIS ORDER (FROM SALESFORCE)</div>' +
      (boxRowsHtml(o, false) || '<div class="empty" style="margin:0">No boxes on this order any more.</div>') + "</div></main>";
  }

  /** Fulfillment order: finished with a box count of 0 and no boxes logged (10-21). */
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
    boxCounts(o, b).forEach(function (c) { used[shortFor(o.lines[c.line].product)] = 1; });
    var words = Object.keys(used);
    var short = words.length ? words.join(" + ") : shortFor(o.lines[0] ? o.lines[0].product : "");
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
        return '<button class="cell' + (q ? " has" : "") + (q > left ? " over" : "") + '" data-act="box-cell" data-k="' + esc(k) + '" aria-pressed="' + (b.sel === k) + '" aria-label="' + esc(s.size) + ", " + q + ' counted">' +
          '<span class="s">' + esc(s.size) + '</span><span class="q">' + (v || "0") + '</span><span class="left">' + Math.max(0, left) + " left</span></button>";
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
      return '<div class="gl"><div class="gl-head">' + esc((l.color ? l.color + " · " : "") + l.product) + "<span>" + (lineCount ? lineCount + " in box" : "") + "</span></div>" +
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
    var ready = total > 0 && total <= 9999 && !!b.type && (!ed || !!b.word);
    var label = state.saving ? "SAVING TO SALESFORCE…" : !ready ? (!b.type ? "PICK A PACKAGING TYPE" : "COUNT AT LEAST ONE SIZE")
      : ed ? "SAVE CHANGES · " + total + " GARMENTS" : "SAVE BOX " + (o.boxes.length + 1) + " · " + total + " GARMENTS";
    var gtName = ed ? b.word + (ed.num ? " " + ed.num : "") : boxName(o, b);
    var words = [];
    if (ed) {
      o.lines.forEach(function (l) { var w = shortFor(l.product); if (words.indexOf(w) < 0) words.push(w); });
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
      '<div class="pad-wrap"><div class="pad-for">' + (selSize || selExtra ? "COUNT FOR <b>" + esc(selName) + "</b>" + (selExtra ? " · EXTRA" : "") + (o.lines.length > 1 ? " · " + esc(selLine.color || selLine.product) : "") : "TAP A SIZE") + "</div>" +
      '<div class="pad">' + keys + "</div>" +
      '<div class="quick"><button data-act="box-rest"' + (selSize && restN ? "" : " disabled") + ">Rest of " + (selSize ? esc(selSize.size) : "size") + " (" + restN + ")</button>" +
      '<button data-act="box-next"' + (selSize || selExtra ? "" : " disabled") + ">Next size →</button></div></div></div>" +
      '<div class="total-bar' + (total ? " on" : "") + '"><div><div class="l">TOTAL IN THIS BOX</div><div class="v" aria-live="polite">' + total + "</div></div>" +
      '<div class="gt">Garment Type<b>' + esc(gtName) + "</b></div></div>" +
      (total > 9999 ? '<div class="fin-warn">One box can hold at most 9999 garments.</div>' : "") +
      '<div class="save-row"><button class="save' + (state.saving ? " busy" : "") + '" data-act="' + (ed ? "save-edit" : "save-box") + '"' + (ready && !state.saving ? "" : " disabled") + ">" +
      (state.saving ? '<span class="spin"></span>' : "") + label + "</button>" +
      (ed ? '<button class="save alt" data-act="close"' + (state.saving ? " disabled" : "") + ">CANCEL</button>"
          : '<button class="save alt" data-act="save-box-new"' + (ready && !state.saving ? "" : " disabled") + ">SAVE BOX &amp; NEW</button>") + "</div></div></div>";
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
  function morph(from, to) {
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { from.parentNode.replaceChild(to, from); return; }
    if (from.nodeType === 3 || from.nodeType === 8) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
    if (from.nodeType !== 1) return;
    var i, a;
    for (i = from.attributes.length - 1; i >= 0; i--) { a = from.attributes[i]; if (!to.hasAttribute(a.name)) from.removeAttribute(a.name); }
    for (i = 0; i < to.attributes.length; i++) { a = to.attributes[i]; if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value); }
    if (from.nodeName === "INPUT" || from.nodeName === "TEXTAREA") {
      var want = to.getAttribute("value") || "";
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
      : state.sheet === "dup" ? dupSheetHtml(o) : state.sheet === "del" ? delSheetHtml(o) : "";
    // Which form for which order/box: a different one is drawn fresh; the same one is updated in place.
    var key = state.sheet + ":" + o.id + ":" + (state.box && state.box.requestId || "") + (state.dup ? ":" + state.dup.requestId : "") + (state.del ? ":" + state.del.requestId : "");
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

  /* ------------------------------------------------------------- saving -- */
  function send(kind, payload, opts) {
    if (state.saving) return;                 // a second tap does nothing
    opts = opts || {};
    state.saving = true; state.pending = { kind: kind, payload: payload, opts: opts };
    state.toast = null; renderToast(); renderOverlay();
    var path = { box: "/api/boxes", fin: "/api/finish", dup: "/api/duplicate-box", edit: "/api/box-edit", del: "/api/box-delete" }[kind] || "/api/misprints";
    api("POST", path, payload).then(function (r) {
      state.saving = false;
      if (!state.user) return;
      if (r.ok && kind === "dup" && r.data && r.data.error === "partial") {
        // Some copies exist, some don't: say exactly that, and never retry the whole batch.
        state.pending = null;
        var po = current();
        if (po) Array.prototype.push.apply(po.boxes, r.data.boxes || []);
        state.sheet = null; state.dup = null; renderOverlay(); renderMain();
        showToast({ kind: "err", title: r.data.created + " CREATED · " + r.data.failed + " NOT CREATED", body: r.data.message || "" });
        loadOrders(true);
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
        } else if (kind === "dup" && o && r.data.boxes) {
          Array.prototype.push.apply(o.boxes, r.data.boxes);
          var bx = r.data.boxes, first = bx[0], last = bx[bx.length - 1];
          showToast({ kind: "ok", title: bx.length + (bx.length === 1 ? " BOX CREATED" : " BOXES CREATED"),
            body: (bx.length === 1 ? "“" + first.name + "”" : "“" + first.name + "” to “" + last.name + "”") + " · " + (first.sizes ? first.sizes.replace(/ = \d+$/, "") + " · " : "") + first.qty + " garments each · " + first.type + ". All confirmed by Salesforce on " + o.num + "." });
        } else if (kind === "box" && o && r.data.box) {
          o.boxes.push(r.data.box);
          showToast({ kind: "ok", title: "BOX SAVED", body: "“" + r.data.box.name + "” · " + (r.data.box.sizes ? r.data.box.sizes.replace(/ = \d+$/, "") + " · " : "") + r.data.box.qty + " garments · " + r.data.box.type + " is in Salesforce on " + o.num + "." });
        } else if (kind === "fin" && o) {
          o.finished = true; o.finishedCount = r.data.boxCount;
          if (r.data.fulfillment) showToast({ kind: "ok", title: "FULFILLMENT ORDER", body: o.num + ": Fulfillment order. No boxes. Saved in Salesforce." + (o.inProduction ? "" : " It's off your board now.") });
          else showToast({ kind: "ok", title: "ORDER FINISHED", body: o.num + ": " + r.data.boxCount + (r.data.boxCount === 1 ? " box" : " boxes") + " saved as the box count in Salesforce." + (o.inProduction ? "" : " It's off your board now.") });
          if (!o.inProduction) {
            state.orders = state.orders.filter(function (x) { return x.id !== o.id; });
            state.selId = state.orders.length ? state.orders[0].id : null; state.view = "list";
          }
        } else if (kind === "mis" && o && r.data.misprint) {
          o.misprintTotal = r.data.misprintTotal;
          var mp = r.data.misprint;
          showToast({ kind: "ok", title: "MISPRINT SAVED", body: mp.qty + " × " + mp.size + " " + mp.garment + " · " + mp.reason + " is on " + o.num + ". The print shop has been notified." });
        }
        state.sheet = null; state.box = null; state.mis = null; state.fin = null; state.dup = null; state.del = null;
        if (kind === "box" && opts.andNew && o) {
          // SAVE BOX & NEW: only now that Salesforce has confirmed, open a fresh, blank box.
          state.box = newBox(o); state.sheet = "box";
        }
        renderOverlay(); renderMain(); renderToast();
        reloadAll();                           // pull the real records back from Salesforce, on both views
      } else if (r.status === 0 || (r.data && r.data.error === "unconfirmed") || (r.data && r.data.error === "in_progress")) {
        state.sheet = null; state.dup = null; state.del = null; renderOverlay();
        showToast({ kind: "unsure", title: kind === "del" ? "NOT SURE IT DELETED" : "NOT SURE IT SAVED", body: (r.data && r.data.message) || "Check the order before trying again." });
        reloadAll();
      } else if (r.status === 401) {
        // signedOut() already ran
      } else {
        renderOverlay();
        showToast({ kind: "err", title: "NOT SAVED", body: (r.data && r.data.message) || "Salesforce did not accept it. Nothing was saved.", retry: r.status >= 500 || r.status === 409 });
        if (r.data && /^(order_not_in_production|review_expired|box_not_found|changed|order_not_found)$/.test(r.data.error)) {
          // The box can't be changed any more (or changed under us): close, keep it visible, re-read from Salesforce.
          state.sheet = null; state.del = null; renderOverlay(); reloadAll();
          state.toast.title = r.data.error === "review_expired" ? "REVIEW PERIOD ENDED" : state.toast.title; state.toast.retry = false; renderToast();
        }
      }
    }).then(afterSave);
  }

  function saveBox(andNew) {
    var o = current(), b = state.box; if (!o || !b) return;
    var counts = boxCounts(o, b), total = boxTotal(o, b);
    if (!total || total > 9999 || !b.type) return;
    send("box", { orderId: o.id, type: b.type, counts: counts, name: boxName(o, b), requestId: b.requestId }, { andNew: !!andNew });
  }

  /** A fresh, blank box form (default Packaging Type, nothing counted, new one-time save id). */
  function newBox(o) {
    var def = state.boxTypes.filter(function (t) { return t.isDefault; })[0];
    var first = o && o.lines[0] && o.lines[0].sizes[0];
    return { type: def ? def.value : "", cells: {}, sel: first ? cellKey(0, first.size) : null, requestId: newRequestId() };
  }
  function saveMis() {
    var o = current(), m = state.mis; if (!o || !m || !m.size || !m.reason) return;
    var line = o.lines[m.line] || {};
    var garment = ((line.color ? line.color + " " : "") + (line.product || "")).trim().slice(0, 40);
    send("mis", { orderId: o.id, qty: m.qty, size: m.size, garment: garment, reason: m.reason, note: (m.note || "").trim(), requestId: m.requestId });
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
      api("POST", "/api/login", { pin: state.pin }).then(function (r) {
        state.pinBusy = false;
        if (r.ok) {
          state.pin = ""; state.pinErr = ""; state.signoutMsg = "";
          loadSetup().then(function () {
            renderAll();
            var d = state.draft;
            if (d && state.user && d.user !== state.user.name) state.draft = null;   // never hand one catcher's entries to another
            (d && d.mode === "past" ? Promise.all([loadOrders(), loadPast()]) : loadOrders()).then(restoreDraft);
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
    reload: function () { if (state.mode === "past") loadPast(); else loadOrders(); },
    pick: function (el) {
      if (state.mode === "past") state.pastSelId = el.getAttribute("data-id"); else state.selId = el.getAttribute("data-id");
      state.view = "detail"; renderMain();
    },
    "search-clear": function () {
      state.q = ""; applySearch();
      var i = document.getElementById("order-search"); if (i) { i.value = ""; i.focus(); }
      if (renderPending) renderMain();
    },
    mode: function (el) {
      var m = el.getAttribute("data-m"); if (m === state.mode) return;
      state.mode = m; state.view = "list"; state.q = ""; renderMain();
      if (m === "past") loadPast(state.pastLoaded); else loadOrders(true);
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
    close: function () { if (state.saving) return; state.sheet = null; renderOverlay(); },
    "box-type": function (el) { state.box.type = el.getAttribute("data-v"); renderOverlay(); },
    "box-cell": function (el) { state.box.sel = el.getAttribute("data-k"); renderOverlay(); },
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

  document.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el || el.disabled) return;
    var fn = handlers[el.getAttribute("data-act")];
    if (fn) fn(el);
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "mis-note" && state.mis) state.mis.note = e.target.value.slice(0, 80);
    if (e.target && e.target.id === "extra-size" && state.box && state.box.adding) state.box.adding.text = e.target.value.slice(0, 10);
    if (e.target && e.target.id === "order-search") { state.q = e.target.value.slice(0, 60); applySearch(); }
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
    if (e.key === "Escape" && state.sheet && !state.saving) { state.sheet = null; renderOverlay(); }
  });
  document.getElementById("zoom-in").addEventListener("click", function () { stepZoom(1); });
  document.getElementById("zoom-out").addEventListener("click", function () { stepZoom(-1); });
  document.getElementById("zoom-reset").addEventListener("click", function () { state.zoom = 1; saveZoom(1); applyZoom(); });
  document.getElementById("who").addEventListener("click", function () {
    if (state.saving) return;
    doLogout("manual");
  });
  window.addEventListener("resize", applyZoom);
  window.addEventListener("beforeunload", function (e) { if (state.saving) { e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !state.user) return;
    keepAwake();
    if (!state.sheet && !state.saving) { if (state.mode === "past") loadPast(true); else loadOrders(true); }
  });

  function tickClock() {
    document.getElementById("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  setInterval(tickClock, 15000); tickClock();
  setInterval(function () {
    if (state.user && !state.sheet && !state.saving && !document.hidden) { if (state.mode === "past") loadPast(true); else loadOrders(true); }
  }, POLL_MS);

  /* ------------------------------------------------------------ start ---- */
  applyZoom();
  // A refresh (any page load) signs out: end any earlier sign-in on the server, then show the PIN pad.
  api("POST", "/api/logout").then(function () {
    renderAll(); setConn("");
  });
})();
