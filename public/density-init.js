// Marks the saved table density on <html> before first paint, so a compact user's tables do not render
// comfortable and then jump when TableDensityProvider hydrates. A static file, not an inline script:
// production CSP allows script-src 'self' only. Mirrors the key and values in
// src/contexts/TableDensityContext.tsx; a test holds them together. styles/globals.css reads the attribute.
(function () {
  try {
    if (window.localStorage.getItem('isaflow.tableDensity') === 'compact') {
      document.documentElement.setAttribute('data-density', 'compact');
    }
  } catch (err) {
    // Storage blocked: the page stays comfortable, as the provider's default. Leave a mark a test and DevTools can read.
    document.documentElement.setAttribute('data-density-init', 'storage-blocked');
  }
})();
