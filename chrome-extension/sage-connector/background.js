// ISAFlow Sage Connector — background service worker
//
// Reads ALL cookies set by accounting.sageone.co.za and returns them
// as a single `Cookie:` header string. Sage's actual auth cookie name
// changes across deployments, so passing every cookie is more robust
// than guessing one name. The server replays the whole string when it
// calls Sage's API, exactly like a browser would.

const SAGE_DOMAIN = 'sageone.co.za';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.source !== 'isaflow') return false;

  if (msg.type === 'getSageCookie') {
    chrome.cookies.getAll({ domain: SAGE_DOMAIN }, (cookies) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      const list = cookies || [];
      if (list.length === 0) {
        sendResponse({ ok: false, error: 'No Sage cookies found. Sign in at accounting.sageone.co.za first.' });
        return;
      }
      // Build a single Cookie: header string — name=value; name=value; …
      const header = list
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      // Names list helps debugging without leaking values
      const names = list.map((c) => c.name);
      sendResponse({ ok: true, value: header, names, count: list.length });
    });
    return true; // async response
  }

  if (msg.type === 'ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  return false;
});
