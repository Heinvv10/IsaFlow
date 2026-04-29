// isaflow-bridge.js — runs on app.isaflow.co.za (and admin/localhost).
//
// Bridges window.postMessage from the IsaFlow page to the extension's
// service worker. Mirror of sage-connector/content.js but for the
// bank-connector message vocabulary.

(function () {
  const PAGE_TO_EXT = {
    'isaflow-bank-ext-ping': 'ping',
    'isaflow-bank-ext-pair': 'pair',
    'isaflow-bank-ext-list': 'list-connections',
    'isaflow-bank-ext-unpair': 'unpair',
    'isaflow-bank-ext-sync': 'sync',
  };

  function announce() {
    window.postMessage({ source: 'isaflow-bank-extension', type: 'announce', version: '0.1.0' }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
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
        window.postMessage({
          source: 'isaflow-bank-extension',
          type: data.type + '-reply',
          requestId: data.requestId,
          ok: !err && resp && resp.ok,
          error: err || (resp && resp.error) || null,
          value: resp && resp.value,
        }, '*');
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
