/* The Catch -- light / dark theme (2026-11-23), the same switch as The Forge's theme.js.
 *
 * Sets <html data-theme="light|dark"> before the page paints, and flips it when anything carrying
 * [data-ca-theme-toggle] is clicked. The choice is kept per device (localStorage "caTheme"). With no
 * saved choice The Catch opens dark, like The Forge's floor stations (station, counting).
 *
 * It never touches the app's data, sign-in or Salesforce calls: a document-level click listener that
 * does not stop the event. All of the look lives in palette.css and nm.css under html[data-theme].
 * Load it as a plain blocking <script> in <head>, so the page never flashes the wrong theme. */
(function () {
  var KEY = 'caTheme';
  var root = document.documentElement;
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function apply(theme) {
    root.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', theme === 'light' ? '#F3E7D2' : '#212322');
  }
  apply(saved() || 'dark');
  document.addEventListener('DOMContentLoaded', function () { apply(root.getAttribute('data-theme')); });
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-ca-theme-toggle]') : null;
    if (!el) return;
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    apply(next);
    try { localStorage.setItem(KEY, next); } catch (err) {}
  });
})();
