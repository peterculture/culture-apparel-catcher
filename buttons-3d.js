/* ── 3D buttons (Anthony 2026-11-02: "add the 3D buttons that The Forge has") ──
   Copied from The Forge (ca-api.js, "3D buttons", commits of 11-02 incl. the Safari fix; its
   test is tools/buttons-3d.mjs there). Same design, same numbers:
     - every filled <button> gets a 4 px lip in its own colour at half brightness, plus a soft
       drop shadow. Near-black faces get a near-black lip; light faces a soft one (80 %).
     - it presses down 4 px on pointerdown (iPad Safari doesn't show :active on a quick tap) and
       springs back ~80 ms after release. The lip goes while it's down.
     - nothing else about a button changes: colours, sizes and layout stay as they were
       (box-shadow and transform take no space).
     - stay flat: ghost buttons (transparent background: the name in the header, the zoom
       buttons), disabled buttons, buttons with their own inline box-shadow/transform, anything
       under data-no3d. Reduced motion: no travel, the lip just goes. Print: no 3D.
     - the lip colour is never written into a button's style attribute (that broke Safari on
       The Forge); each lip colour is one rule in our own <style>, and the button gets classes.

   The Catch's own differences:
     - The Catch updates forms in place (morph() in app.js) and rewrites a button's class while
       you tap. morph() keeps the ca-3d / ca-lip-N / ca-down / ca-live classes, so a button
       never flickers flat or pops up mid-press. Any class/style/disabled change re-checks the
       button (a size tile turning red gets a red lip); dress() only writes when something
       differs, so it never loops.
     - The order list is rebuilt on every refresh. The press animation is only switched on
       while a finger is on a button (ca-live), so freshly drawn buttons don't animate their
       lip in every 15 seconds.
     - A button placed with a CSS transform of its own (the search box's clear ×) stays flat,
       so pressing can't knock it out of place. */
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined" ||
      typeof MutationObserver === "undefined" || typeof window.getComputedStyle !== "function") return;
  var LIP = 4;
  var CSS =
    "button.ca-3d{box-shadow:0 " + LIP + "px 0 var(--ca-lip,#050506),0 " + (LIP + 4) + "px 10px var(--ca-drop,rgba(0,0,0,.45));-webkit-tap-highlight-color:transparent}" +
    "button.ca-3d.ca-live{transition:transform 60ms ease-out,box-shadow 60ms ease-out}" +
    "button.ca-3d.ca-down{transform:translateY(" + LIP + "px);box-shadow:0 0 0 var(--ca-lip,#050506),0 1px 2px rgba(0,0,0,.4)}" +
    "@media (prefers-reduced-motion:reduce){button.ca-3d,button.ca-3d.ca-live,button.ca-3d.ca-down{transition:none}button.ca-3d.ca-down{transform:none}}" +
    "@media print{button.ca-3d{box-shadow:none!important;transform:none!important}}";

  function rgba(str) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(str || "");
    if (!m) return null;
    var a = m[4] == null ? 1 : (m[4].slice(-1) === "%" ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }
  /* The face colour: background-color, or the first colour of a gradient. */
  function faceOf(cs) {
    var c = rgba(cs.backgroundColor);
    if (c && c.a >= 0.15) return c;
    if (cs.backgroundImage && cs.backgroundImage !== "none") {
      var g = rgba((/rgba?\([^)]*\)/.exec(cs.backgroundImage) || [])[0]);
      if (g && g.a >= 0.15) return g;
    }
    return null;
  }
  /* The lip: the same hue, about half as bright. Very dark faces get a near-black lip so it
     still shows against the dark cards; light faces a soft edge, not a grey slab. */
  function lipOf(f) {
    var lum = (0.2126 * f.r + 0.7152 * f.g + 0.0722 * f.b) / 255;
    if (lum < 0.12) return "rgba(0,0,0,.75)";
    var k = lum > 0.6 ? 0.8 : 0.5;
    return "rgb(" + Math.round(f.r * k) + "," + Math.round(f.g * k) + "," + Math.round(f.b * k) + ")";
  }
  function isLight(f) { return (0.2126 * f.r + 0.7152 * f.g + 0.0722 * f.b) / 255 > 0.6; }
  /* lip colour -> class name, with one rule each in our own stylesheet */
  var lipClass = {}, lipN = 0, sheet = null;
  function classFor(lip, light) {
    var key = lip + (light ? "|l" : "");
    if (lipClass[key]) return lipClass[key];
    var c = "ca-lip-" + (++lipN); lipClass[key] = c;
    var rule = "button.ca-3d." + c + "{--ca-lip:" + lip + (light ? ";--ca-drop:rgba(0,0,0,.28)" : "") + "}";
    try { sheet.insertRule(rule, sheet.cssRules.length); } catch (e) { /* bad colour: stays on the default lip */ }
    return c;
  }
  function flatten(b) {
    if (!b.classList.contains("ca-3d")) return;
    b.classList.remove("ca-3d", "ca-down", "ca-live");
    var drop = [];
    b.classList.forEach(function (c) { if (c.indexOf("ca-lip-") === 0) drop.push(c); });
    drop.forEach(function (c) { b.classList.remove(c); });
  }
  function dress(b) {
    if (b.disabled || b.hasAttribute("data-no3d") || (b.closest && b.closest("[data-no3d]")) ||
        (b.style && (b.style.boxShadow || b.style.transform))) { flatten(b); return; }
    var cs = window.getComputedStyle(b);
    // Placed with a transform of its own (not ours): pressing would move it. Stay flat.
    if (!b.classList.contains("ca-down") && cs.transform && cs.transform !== "none") { flatten(b); return; }
    var face = faceOf(cs);
    if (!face) { flatten(b); return; }
    var want = classFor(lipOf(face), isLight(face));
    var have = null;
    b.classList.forEach(function (c) { if (c.indexOf("ca-lip-") === 0) have = c; });
    if (have !== want) { if (have) b.classList.remove(have); b.classList.add(want); }
    if (!b.classList.contains("ca-3d")) b.classList.add("ca-3d");
  }
  var pending = false, queue = new Set();
  function flush() {
    pending = false;
    var list = queue; queue = new Set();
    list.forEach(function (b) { if (b.isConnected) dress(b); });
  }
  function want(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === "BUTTON") queue.add(node);
    if (node.querySelectorAll) node.querySelectorAll("button").forEach(function (b) { queue.add(b); });
    if (!pending) { pending = true; (window.requestAnimationFrame || setTimeout)(flush); }
  }
  function start() {
    if (document.getElementById("ca-3d-style")) return;
    var st = document.createElement("style"); st.id = "ca-3d-style"; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
    var st2 = document.createElement("style"); st2.id = "ca-3d-lips";
    (document.head || document.documentElement).appendChild(st2);
    sheet = st2.sheet;
    want(document.body);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === "childList") m.addedNodes.forEach(want);
        else if (m.target && m.target.tagName === "BUTTON") want(m.target);   // dress() writes only on a difference
        else if (m.target) want(m.target);                                     // a parent's class can change a button's colour
      });
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "disabled"] });
    var held = null, t = null;
    function release(b) {
      b.classList.remove("ca-down");
      setTimeout(function () { if (!b.classList.contains("ca-down")) b.classList.remove("ca-live"); }, 140);
    }
    document.addEventListener("pointerdown", function (e) {
      var b = e.target && e.target.closest && e.target.closest("button.ca-3d");
      if (!b || b.disabled) return;
      clearTimeout(t); if (held && held !== b) release(held);
      held = b; b.classList.add("ca-live", "ca-down");
    }, true);
    var up = function () { var b = held; held = null; if (b) t = setTimeout(function () { release(b); }, 80); };
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("keydown", function (e) {
      if (e.key !== " " && e.key !== "Enter") return;
      var b = e.target && e.target.closest && e.target.closest("button.ca-3d");
      if (!b) return; b.classList.add("ca-live", "ca-down"); setTimeout(function () { release(b); }, 120);
    }, true);
  }
  function safeStart() { try { start(); } catch (e) { if (window.console) console.warn("[ca-3d] buttons left flat:", e); } }
  if (document.body) safeStart(); else document.addEventListener("DOMContentLoaded", safeStart);
})();
