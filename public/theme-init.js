// Applies the saved colour theme before first paint so there is no flash of the wrong one.
// A static file, not an inline script: production CSP allows script-src 'self' only.
// Mirrors src/lib/theme/themePreference.ts (resolveTheme / applyTheme / isLightOnlyPath); a test holds them together.
(function () {
  var root = document.documentElement;
  var dark = true;
  try {
    var saved = window.localStorage.getItem('accounting-theme');
    if (saved === 'light') dark = false;
    else if (saved === 'system') dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (err) {
    dark = true;
  }
  // Public and customer-facing paths are always light.
  if (/^\/(portal|share|audit-portal)(\/|$)|^\/accounting\/afs\/(sign|portal)(\/|$)/.test(window.location.pathname)) dark = false;
  root.classList.toggle('dark', dark);
  root.style.setProperty('color-scheme', dark ? 'dark' : 'light');
})();
