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
    sheet: null,           // "box" | "mis" | "mock"
    box: null,             // { line, type, qty }
    mis: null,             // { line, size, qty, reason, note }
    saving: false,
    pending: null,         // last save, so "Try again" re-sends the SAME request id
    toast: null,           // { kind: ok|err|unsure, title, body, retry }
    pin: ""
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
  function current() {
    for (var i = 0; i < state.orders.length; i++) if (state.orders[i].id === state.selId) return state.orders[i];
    return null;
  }
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

  function signedOut() {
    state.user = null; state.sheet = null; state.saving = false; state.pin = "";
    renderAll();
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
        if (!current()) state.selId = state.orders.length ? state.orders[0].id : null;
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

  function loadSetup() {
    return Promise.all([api("GET", "/api/me"), api("GET", "/api/box-types")]).then(function (rs) {
      if (rs[0].ok) { state.user = { name: rs[0].data.name }; state.reasons = rs[0].data.reasons || []; }
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
    $app.innerHTML = listHtml() + detailHtml();
    wireImages();
    applyZoom();
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
    return '<div class="pin-wrap"><div class="pin-box">' +
      "<h1>WHO'S CATCHING?</h1><p>Enter your 4-digit PIN</p>" +
      '<div class="dots" id="dots">' + dots + "</div>" +
      '<div class="pin-err" id="pin-err">' + esc(state.pinErr || "") + "</div>" +
      '<div class="pin-pad">' + keys + "</div></div></div>";
  }

  function listHtml() {
    var cards = state.orders.map(function (o) {
      var sel = o.id === state.selId;
      var thumb = o.hasMockup ? '<img class="thumb-img" alt="" data-mock="' + esc(o.id) + ':0"><span class="mock-wait">' + ICON.shirt + "</span>" : ICON.shirt;
      return '<button class="card" data-act="pick" data-id="' + esc(o.id) + '" aria-pressed="' + sel + '">' +
        '<span class="thumb">' + thumb + "</span>" +
        '<span class="card-body"><span class="card-num">' + esc(o.num) + "</span>" +
        '<span class="card-cust">' + esc(o.customer) + "</span>" +
        '<span class="card-meta">' + o.total + " garments · " + o.boxes.length + (o.boxes.length === 1 ? " box" : " boxes") + "</span></span></button>";
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
    return '<section class="list" aria-label="Orders in production">' +
      '<div class="list-head"><div class="list-title"><h1>IN PRODUCTION</h1><span class="list-count">' + state.orders.length + "</span></div>" +
      '<div class="list-sub"><i></i>SCREEN PRINT ONLY</div></div>' + body + "</section>";
  }

  function detailHtml() {
    var o = current();
    if (!o) return '<main class="detail"><div class="empty">Pick an order on the left.</div></main>';
    var boxed = o.boxes.reduce(function (a, b) { return a + b.qty; }, 0);
    var mock = o.hasMockup
      ? '<button class="mock" data-act="mock" data-id="' + esc(o.id) + '" aria-label="Open the mockup full size"><img class="mock-img" alt="Mockup for ' + esc(o.num) + '" data-mock="' + esc(o.id) + ':0"><span class="mock-wait mock-none">LOADING<br>MOCKUP…</span><span class="badge">' + ICON.expand + '</span><span class="cap">' + ((o.mockupCount || 1) > 1 ? "TAP TO SEE ALL " + o.mockupCount : "TAP TO ENLARGE") + '</span></button>'
      : '<div class="mock"><span class="mock-none">NO MOCKUP<br>IN SALESFORCE</span></div>';
    var lines = o.lines.map(function (l) {
      return '<div><div class="line-head"><span>' + esc(l.product) + (l.color ? " · " + esc(l.color) : "") + '</span><span class="tot">' + l.total + "</span></div>" +
        '<div class="sizes">' + l.sizes.map(function (s) {
          return '<div class="size"><div class="s">' + esc(s.size) + '</div><div class="q">' + s.qty + "</div></div>";
        }).join("") + "</div></div>";
    }).join("");
    var log = o.boxes.map(function (b, i) {
      return '<div class="log-row"><span class="log-icon">' + (i + 1) + '</span><span class="log-text">Box “' + esc(b.name) + "” · " + b.qty + " garments · " + esc(b.type) +
        '</span><span class="log-who">' + esc(b.by) + (b.at ? " · " + fmtTime(b.at) : "") + "</span></div>";
    }).join("");
    var misLog = o.misprintNotes ? '<div class="sec-label" style="margin-top:.6rem">MISPRINT NOTES IN SALESFORCE</div><div class="notes">' + esc(o.misprintNotes.split(" | ").join("\n")) + "</div>" : "";
    return '<main class="detail">' +
      '<button class="back narrow-only" data-act="back">' + ICON.back + "ALL ORDERS</button>" +
      '<div class="d-top">' + mock + '<div class="d-id"><h2 class="d-num">' + esc(o.num) + "</h2>" +
      '<div class="d-cust">' + esc(o.customer) + "</div>" +
      '<div class="d-meta">Print date ' + esc(fmtDate(o.printDate)) + (o.specs ? " · " + esc(o.specs) : "") + "</div></div></div>" +
      '<div class="panel">' + (lines || '<div class="hint">No garment sizes on this order in Salesforce.</div>') + "</div>" +
      '<div class="stats"><div class="stat"><div class="l">BOXES</div><div class="v">' + o.boxes.length + "</div></div>" +
      '<div class="stat"><div class="l">BOXED</div><div class="v">' + boxed + " <small>/ " + o.total + "</small></div></div>" +
      '<div class="stat"><div class="l">MISPRINTS</div><div class="v' + (o.misprintTotal ? " warn" : "") + '">' + o.misprintTotal + "</div></div></div>" +
      '<div class="actions"><button class="big big-red" data-act="open-box">' + ICON.box + "LOG BOXES</button>" +
      '<button class="big big-warn" data-act="open-mis">' + ICON.warn + "REPORT MISPRINT</button></div>" +
      '<div class="log"><div class="sec-label">BOXES ON THIS ORDER</div>' +
      (log || '<div class="empty" style="margin:0">No boxes logged yet.</div>') + misLog + "</div>" +
      "</main>";
  }

  /* ----------------------------------------------------------- sheets ---- */
  function boxName(o, lineIdx) {
    var line = o.lines[lineIdx] || o.lines[0];
    var short = shortFor(line ? line.product : "");
    var n = o.boxes.filter(function (b) { return String(b.name).indexOf(short + " ") === 0 || b.name === short; }).length + 1;
    return short + " " + n;
  }

  function boxSheetHtml(o) {
    var b = state.box, qty = parseInt(b.qty || "0", 10) || 0;
    var boxed = o.boxes.reduce(function (a, x) { return a + x.qty; }, 0);
    var remaining = Math.max(0, o.total - boxed);
    var last = o.boxes.length ? o.boxes[o.boxes.length - 1].qty : 0;
    var lineChips = o.lines.length > 1 ? '<div><div class="sec-label">WHAT\'S IN THE BOX</div><div class="chips">' + o.lines.map(function (l, i) {
      return '<button class="chip" data-act="box-line" data-i="' + i + '" aria-pressed="' + (b.line === i) + '">' + esc(l.color ? l.color + " " : "") + esc(shortFor(l.product).toLowerCase()) + "</button>";
    }).join("") + "</div></div>" : "";
    var types = state.boxTypes.length ? state.boxTypes.map(function (t) {
      return '<button class="chip" data-act="box-type" data-v="' + esc(t.value) + '" aria-pressed="' + (b.type === t.value) + '">' + esc(t.label) + "</button>";
    }).join("") : '<div class="hint">Box types could not be loaded. Close and try again.</div>';
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "<"].map(function (k) {
      var label = k === "<" ? "⌫" : k === "C" ? "CLR" : k;
      return '<button data-act="box-key" data-k="' + k + '" class="' + (k === "<" || k === "C" ? "k2" : "") + '" aria-label="' + (k === "<" ? "Delete last digit" : k === "C" ? "Clear" : k) + '">' + label + "</button>";
    }).join("");
    var ready = qty > 0 && !!b.type;
    var label = state.saving ? "SAVING TO SALESFORCE…" : ready ? "SAVE BOX " + (o.boxes.length + 1) + " · " + qty + " GARMENTS" : !b.type ? "PICK A BOX TYPE" : "ENTER GARMENT COUNT";
    return '<div class="scrim"><div class="sheet" role="dialog" aria-label="Log a box">' +
      '<div class="sheet-head"><div class="sheet-title"><h2>LOG BOX ' + (o.boxes.length + 1) + " · " + esc(o.num) + "</h2>" +
"<p>" + o.boxes.length + (o.boxes.length === 1 ? " box" : " boxes") + " saved · " + boxed + " of " + o.total + " garments boxed</p></div>" +
      '<button class="x" data-act="close" aria-label="Close">' + ICON.x + "</button></div>" +
      lineChips +
      '<div><div class="sec-label">1 · BOX TYPE</div><div class="chips">' + types + "</div></div>" +
      '<div class="row2"><div class="grow"><div class="sec-label">2 · GARMENTS IN THIS BOX</div>' +
      '<div class="qty-show' + (qty ? " on" : "") + '" aria-live="polite">' + (b.qty || "0") + "</div>" +
      '<div class="quick"><button data-act="box-rest">Rest of order (' + remaining + ")</button>" +
      (last ? '<button data-act="box-last">Same as last box (' + last + ")</button>" : "") + "</div>" +
      '<div class="hint">Saves as <b>“' + esc(boxName(o, b.line)) + '”</b></div></div>' +
      '<div class="pad">' + keys + "</div></div>" +
      '<button class="save' + (state.saving ? " busy" : "") + '" data-act="save-box"' + (ready && !state.saving ? "" : " disabled") + ">" +
      (state.saving ? '<span class="spin"></span>' : "") + label + "</button></div></div>";
  }

  function misSheetHtml(o) {
    var m = state.mis, line = o.lines[m.line] || { sizes: [] };
    var lineChips = o.lines.length > 1 ? '<div><div class="sec-label">GARMENT</div><div class="chips">' + o.lines.map(function (l, i) {
      return '<button class="chip" data-act="mis-line" data-i="' + i + '" aria-pressed="' + (m.line === i) + '">' + esc((l.color ? l.color + " " : "") + l.product) + "</button>";
    }).join("") + "</div></div>" : "";
    var sizes = line.sizes.map(function (s) {
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

  function renderOverlay() {
    var o = current();
    var active = document.activeElement && document.activeElement.id === "mis-note";
    var caret = active ? document.activeElement.selectionStart : null;
    if (!state.user || !state.sheet || !o) { $overlay.innerHTML = ""; return; }
    if (state.sheet === "box") $overlay.innerHTML = boxSheetHtml(o);
    else if (state.sheet === "mis") $overlay.innerHTML = misSheetHtml(o);
    else if (state.sheet === "mock") { $overlay.innerHTML = viewerHtml(o); fillMockups($overlay); setupViewer(); }
    if (active) {
      var el = document.getElementById("mis-note");
      if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) {} }
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
  function send(kind, payload) {
    if (state.saving) return;                 // a second tap does nothing
    state.saving = true; state.pending = { kind: kind, payload: payload };
    state.toast = null; renderToast(); renderOverlay();
    var path = kind === "box" ? "/api/boxes" : "/api/misprints";
    api("POST", path, payload).then(function (r) {
      state.saving = false;
      if (r.ok) {
        state.pending = null;
        var o = current();
        if (kind === "box" && o && r.data.box) {
          o.boxes.push(r.data.box);
          showToast({ kind: "ok", title: "BOX SAVED", body: "“" + r.data.box.name + "” · " + r.data.box.qty + " garments · " + r.data.box.type + " is in Salesforce on " + o.num + "." });
        } else if (kind === "mis" && o && r.data.misprint) {
          o.misprintTotal = r.data.misprintTotal;
          var mp = r.data.misprint;
          showToast({ kind: "ok", title: "MISPRINT SAVED", body: mp.qty + " × " + mp.size + " " + mp.garment + " · " + mp.reason + " is on " + o.num + ". The print shop has been notified." });
        }
        state.sheet = null; state.box = null; state.mis = null;
        renderOverlay(); renderMain();
        loadOrders(true);                      // pull the real numbers back from Salesforce
      } else if (r.status === 0 || (r.data && r.data.error === "unconfirmed") || (r.data && r.data.error === "in_progress")) {
        state.sheet = null; renderOverlay();
        showToast({ kind: "unsure", title: "NOT SURE IT SAVED", body: (r.data && r.data.message) || "Check the order before trying again." });
        loadOrders(true);
      } else if (r.status === 401) {
        // signedOut() already ran
      } else {
        renderOverlay();
        showToast({ kind: "err", title: "NOT SAVED", body: (r.data && r.data.message) || "Salesforce did not accept it. Nothing was saved.", retry: r.status >= 500 || r.status === 409 });
        if (r.data && r.data.error === "order_not_in_production") { state.sheet = null; renderOverlay(); loadOrders(true); }
      }
    });
  }

  function saveBox() {
    var o = current(), b = state.box; if (!o || !b) return;
    var qty = parseInt(b.qty || "0", 10);
    if (!qty || !b.type) return;
    send("box", { orderId: o.id, type: b.type, qty: qty, name: boxName(o, b.line), requestId: b.requestId });
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
          state.pin = ""; state.pinErr = "";
          loadSetup().then(function () { renderAll(); loadOrders(); });
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
    reload: function () { loadOrders(); },
    pick: function (el) { state.selId = el.getAttribute("data-id"); state.view = "detail"; renderMain(); },
    back: function () { state.view = "list"; applyZoom(); },
    mock: function () { state.mockIdx = 0; state.sheet = "mock"; renderOverlay(); },
    "v-prev": function () { state.mockIdx = Math.max(0, (state.mockIdx || 0) - 1); renderOverlay(); },
    "v-next": function () { var o = current(); state.mockIdx = Math.min(((o && o.mockupCount) || 1) - 1, (state.mockIdx || 0) + 1); renderOverlay(); },
    "open-box": function () {
      if (!state.boxTypes.length) api("GET", "/api/box-types").then(function (r) { if (r.ok) { state.boxTypes = r.data.types || []; renderOverlay(); } });
      var def = state.boxTypes.filter(function (t) { return t.isDefault; })[0];
      state.box = { line: 0, type: def ? def.value : "", qty: "", requestId: newRequestId() };
      state.sheet = "box"; state.toast = null; renderToast(); renderOverlay();
    },
    "open-mis": function () {
      state.mis = { line: 0, size: null, qty: 1, reason: null, note: "", requestId: newRequestId() };
      state.sheet = "mis"; state.toast = null; renderToast(); renderOverlay();
    },
    close: function () { if (state.saving) return; state.sheet = null; renderOverlay(); },
    "box-line": function (el) { state.box.line = Number(el.getAttribute("data-i")); renderOverlay(); },
    "box-type": function (el) { state.box.type = el.getAttribute("data-v"); renderOverlay(); },
    "box-key": function (el) {
      var k = el.getAttribute("data-k"), v = state.box.qty || "";
      if (k === "C") v = ""; else if (k === "<") v = v.slice(0, -1); else if (v.length < 4) v = (v === "0" ? "" : v) + k;
      state.box.qty = v; renderOverlay();
    },
    "box-rest": function () {
      var o = current(); var boxed = o.boxes.reduce(function (a, x) { return a + x.qty; }, 0);
      var rest = Math.max(0, o.total - boxed); state.box.qty = rest ? String(rest) : ""; renderOverlay();
    },
    "box-last": function () { var o = current(); state.box.qty = String(o.boxes[o.boxes.length - 1].qty); renderOverlay(); },
    "save-box": saveBox,
    "mis-line": function (el) { state.mis.line = Number(el.getAttribute("data-i")); state.mis.size = null; renderOverlay(); },
    "mis-size": function (el) { state.mis.size = el.getAttribute("data-v"); renderOverlay(); },
    "mis-reason": function (el) { state.mis.reason = el.getAttribute("data-v"); renderOverlay(); },
    "mis-minus": function () { state.mis.qty = Math.max(1, state.mis.qty - 1); renderOverlay(); },
    "mis-plus": function () { state.mis.qty = Math.min(99, state.mis.qty + 1); renderOverlay(); },
    "save-mis": saveMis,
    retry: function () { if (state.pending) { var p = state.pending; state.pending = null; send(p.kind, p.payload); } },
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
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.sheet && !state.saving) { state.sheet = null; renderOverlay(); }
  });
  document.getElementById("zoom-in").addEventListener("click", function () { stepZoom(1); });
  document.getElementById("zoom-out").addEventListener("click", function () { stepZoom(-1); });
  document.getElementById("zoom-reset").addEventListener("click", function () { state.zoom = 1; saveZoom(1); applyZoom(); });
  document.getElementById("who").addEventListener("click", function () {
    if (state.saving) return;
    api("POST", "/api/logout").then(signedOut);
  });
  window.addEventListener("resize", applyZoom);
  window.addEventListener("beforeunload", function (e) { if (state.saving) { e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && !state.sheet && !state.saving) loadOrders(true); });

  function tickClock() {
    document.getElementById("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  setInterval(tickClock, 15000); tickClock();
  setInterval(function () {
    if (state.user && !state.sheet && !state.saving && !document.hidden) loadOrders(true);
  }, POLL_MS);

  /* ------------------------------------------------------------ start ---- */
  applyZoom();
  loadSetup().then(function () {
    renderAll();
    if (state.user) loadOrders(); else setConn("");
  });
})();
