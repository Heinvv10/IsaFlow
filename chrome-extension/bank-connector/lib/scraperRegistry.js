// scraperRegistry — runs in the service worker. Per-bank scrapers register
// themselves at install time via chrome.runtime.sendMessage('register-scraper').
// Each scraper is a content-script-side adapter that the service worker
// invokes by sending it RPC messages: 'isAuthenticated', 'listAccounts',
// 'fetchTransactions'.
//
// The actual scraping logic lives in the per-bank content scripts (e.g.
// content/absa.js). This module is just the dispatch table.

self.SCRAPER_REGISTRY = self.SCRAPER_REGISTRY || {
  // bankId -> { tabId, version }
  byBank: {},
  register(bankId, tabId, version) {
    this.byBank[bankId] = { tabId, version, registeredAt: Date.now() };
  },
  unregister(bankId) {
    delete this.byBank[bankId];
  },
  get(bankId) {
    return this.byBank[bankId] || null;
  },
};
