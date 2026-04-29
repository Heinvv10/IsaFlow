// ISAFlow Bank Connector — background service worker (MV3).
//
// Coordinates pairing (token from IsaFlow page → chrome.storage), scraper
// registration (per-bank content scripts announce themselves on load),
// and sync orchestration (call scraper RPC → POST results to IsaFlow).
//
// Trust boundaries:
//   - Pairing JWT is minted server-side by IsaFlow and stored in
//     chrome.storage.local. Bank credentials NEVER touch this extension.
//   - Per-bank content scripts only run on their bank's host (declared
//     in manifest content_scripts) and use the user's existing
//     authenticated session cookies.
//   - Service worker can NOT read bank cookies directly — that's left to
//     the content scripts running inside the user's bank tab.

importScripts('lib/scraperRegistry.js', 'lib/api.js');

const VERSION = chrome.runtime.getManifest().version;

// ── Message bus ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== 'isaflow-bank') return false;

  if (msg.type === 'ping') {
    sendResponse({ ok: true, version: VERSION });
    return false;
  }

  if (msg.type === 'pair') {
    handlePair(msg.payload).then(
      (record) => sendResponse({ ok: true, value: record }),
      (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }),
    );
    return true;
  }

  if (msg.type === 'list-connections') {
    self.IsaflowApi.listConnections().then(
      (list) => sendResponse({ ok: true, value: list }),
      (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }),
    );
    return true;
  }

  if (msg.type === 'unpair') {
    self.IsaflowApi.deleteConnection(msg.connectionId).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }),
    );
    return true;
  }

  if (msg.type === 'register-scraper') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'No tab' });
      return false;
    }
    self.SCRAPER_REGISTRY.register(msg.bankId, tabId, msg.version);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'sync') {
    handleSync(msg.connectionId, msg.opts || {}).then(
      (out) => sendResponse({ ok: true, value: out }),
      (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }),
    );
    return true;
  }

  return false;
});

// ── Pairing ──────────────────────────────────────────────────────────────────

const ALLOWED_HOSTS = new Set([
  'https://app.isaflow.co.za',
  'https://admin.isaflow.co.za',
  'http://localhost:3200',
  'http://localhost:3000',
]);

async function handlePair(payload) {
  if (!payload || !payload.connectionId || !payload.jwt || !payload.ingestUrl || !payload.bankId) {
    throw new Error('Invalid pair payload');
  }
  const host = payload.host || 'https://app.isaflow.co.za';
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`Untrusted host rejected: ${host}`);
  }
  const record = {
    connectionId: payload.connectionId,
    jwt: payload.jwt,
    bankId: payload.bankId,
    bankAccountExternalId: payload.bankAccountExternalId || null,
    bankAccountLabel: payload.bankAccountLabel || null,
    ingestUrl: payload.ingestUrl,
    host,
    pairedAt: new Date().toISOString(),
    lastSyncAt: null,
  };
  await self.IsaflowApi.saveConnection(record);
  return record;
}

// ── Sync orchestration ───────────────────────────────────────────────────────

async function handleSync(connectionId, opts) {
  const conn = await self.IsaflowApi.getConnection(connectionId);
  if (!conn) throw new Error('Unknown connection');
  const reg = self.SCRAPER_REGISTRY.get(conn.bankId);
  if (!reg) {
    throw new Error('Bank tab not open. Please log in to your bank in another tab.');
  }

  const fromDate = opts.fromDate || isoDaysAgo(opts.daysBack || 30);
  const toDate = opts.toDate || todayIso();

  const txs = await sendToTab(reg.tabId, {
    type: 'fetchTransactions',
    accountNumber: conn.bankAccountExternalId,
    fromDate,
    toDate,
  });
  if (!txs || !Array.isArray(txs.transactions)) {
    throw new Error(txs && txs.error ? txs.error : 'Scraper returned no transactions');
  }

  const ingestRes = await self.IsaflowApi.ingest(conn, {
    scraperId: conn.bankId,
    scraperVersion: reg.version || VERSION,
    bankAccountExternalId: conn.bankAccountExternalId || '',
    fromDate,
    toDate,
    transactions: txs.transactions,
    applyBankRules: opts.applyBankRules !== false,
  });

  if (!ingestRes.ok) {
    throw new Error('Ingest failed: ' + (ingestRes.body && ingestRes.body.error ? JSON.stringify(ingestRes.body.error) : ingestRes.status));
  }

  conn.lastSyncAt = new Date().toISOString();
  await self.IsaflowApi.saveConnection(conn);

  return ingestRes.body && ingestRes.body.data ? ingestRes.body.data : ingestRes.body;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { source: 'isaflow-bank', ...msg }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!resp) return reject(new Error('No response from scraper'));
      if (resp.ok === false) return reject(new Error(resp.error || 'Scraper failed'));
      resolve(resp.value);
    });
  });
}

function todayIso() { return new Date().toISOString().slice(0, 10); }
function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
