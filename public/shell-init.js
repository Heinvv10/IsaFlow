// Marks the saved shell layout on <html> before first paint, so the loading skeleton (ShellSkeleton) draws the
// sidebar or the top nav rows the shell will have, and nothing moves when the shell replaces it.
// A static file, not an inline script: production CSP allows script-src 'self' only. Mirrors AppLayout's
// NAV_MODE_KEY / SIDEBAR_COLLAPSED_KEY and its admin-host check; the rules that read these are in styles/globals.css.
(function () {
  var root = document.documentElement;
  try {
    if (window.localStorage.getItem('accounting-nav-mode') === 'side') root.setAttribute('data-nav-mode', 'side');
    if (window.localStorage.getItem('accounting-sidebar-collapsed') === 'true') root.setAttribute('data-sidebar-collapsed', 'true');
  } catch (err) {
    // Storage blocked: the skeleton keeps the default top-nav layout.
  }
  if (window.location.hostname === 'admin.isaflow.co.za') root.setAttribute('data-admin-host', 'true');
})();
