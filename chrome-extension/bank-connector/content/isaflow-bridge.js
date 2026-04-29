// isaflow-bridge.js — runs on app.isaflow.co.za (and admin/localhost).
//
// Bridges window.postMessage from the IsaFlow page to the extension's
// service worker. Mirror of sage-connector/content.js but for the
// bank-connector message vocabulary.

(function () {
  // Only accept postMessages from known IsaFlow origins. Any message that
  // arrives on a non-allowlisted origin is silently dropped so a malicious
  // page embedded in an iframe can never exfiltrate the pairing JWT.
  const ALLOWED_ORIGINS = new Set([
    'https://app.isaflow.co.za',
    'https://admin.isaflow.co.za',
    'http://localhost:3200',
    'http://localhost:3000',
  ]);

  const PAGE_TO_EXT = {
    'isaflow-bank-ext-ping': 'ping',
    'isaflow-bank-ext-pair': 'pair',
    'isaflow-bank-ext-sync': 'sync',
  };

  function announce() {
    window.postMessage({ source: 'isaflow-bank-extension', type: 'announce', version: '0.1.0' }, window.location.origin);
  }

  window.addEventListener('message', (event) => {
    // Guard 1: must originate from this window (not cross-frame).
    if (event.source !== window) return;
    // Guard 2: origin must be in the allowlist — prevents relay attacks.
    if (!ALLOWED_ORIGINS.has(event.origin)) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== 'isaflow-bank-page') return;

    const extType = PAGE_TO_EXT[data.type];
    if (!extType) return;

    chrome.runtime.sendMessage(
      {
        source: 'isaflow-bank',
        type: extType,
        payload: data.payload,
        connectionId: data.connectionId,
        opts: data.opts,
      },
      (resp) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        // Reply only to the same origin that sent the request.
        window.postMessage({
          source: 'isaflow-bank-extension',
          type: data.type + '-reply',
          requestId: data.requestId,
          ok: !err && resp && resp.ok,
          error: err || (resp && resp.error) || null,
          value: resp && resp.value,
        }, event.origin);
      },
    );
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce, { once: true });
  } else {
    announce();
  }
  window.addEventListener('focus', announce);
})();
