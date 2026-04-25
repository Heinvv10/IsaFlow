// ISAFlow Sage Connector — content script (runs on ISAFlow pages)
//
// Bridges window.postMessage from the page to the extension's background
// service worker. The page can:
//   1. Detect we're installed by sending {type:'isaflow-sage-ext-ping'}
//   2. Request the Sage session cookie via {type:'isaflow-sage-ext-getCookie'}
//
// Replies use postMessage with a matching `requestId` so concurrent
// requests don't collide.

(function () {
  const PAGE_TO_EXT = {
    'isaflow-sage-ext-ping': 'ping',
    'isaflow-sage-ext-getCookie': 'getSageCookie',
  };

  function announce() {
    window.postMessage({ source: 'isaflow-sage-extension', type: 'announce', version: '1.1.0' }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== 'isaflow-sage-page') return;

    const extType = PAGE_TO_EXT[data.type];
    if (!extType) return;

    chrome.runtime.sendMessage({ source: 'isaflow', type: extType }, (resp) => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      window.postMessage({
        source: 'isaflow-sage-extension',
        type: data.type + '-reply',
        requestId: data.requestId,
        ok: !err && resp && resp.ok,
        error: err || (resp && resp.error) || null,
        value: resp && resp.value,
        names: resp && resp.names,
        count: resp && resp.count,
        version: resp && resp.version,
      }, '*');
    });
  });

  // Announce on load + on every focus (so the page can refresh its
  // installed-status badge if the user toggles the extension).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce, { once: true });
  } else {
    announce();
  }
  window.addEventListener('focus', announce);
})();
