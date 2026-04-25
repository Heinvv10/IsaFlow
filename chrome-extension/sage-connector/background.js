// ISAFlow Sage Connector — background service worker
//
// Reads the .AspNet.ApplicationCookie from accounting.sageone.co.za and
// returns it to the page that requested it (via the content script).
// Only responds to messages from our content script in the manifest's
// matched ISAFlow origins.

const SAGE_URL = 'https://accounting.sageone.co.za';
const COOKIE_NAME = '.AspNet.ApplicationCookie';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.source !== 'isaflow') return false;

  if (msg.type === 'getSageCookie') {
    chrome.cookies.get({ url: SAGE_URL, name: COOKIE_NAME }, (cookie) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (!cookie) {
        sendResponse({ ok: false, error: 'No Sage session cookie found. Sign in at accounting.sageone.co.za first.' });
        return;
      }
      sendResponse({ ok: true, value: cookie.value, expirationDate: cookie.expirationDate ?? null });
    });
    return true; // async response
  }

  if (msg.type === 'ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  return false;
});
