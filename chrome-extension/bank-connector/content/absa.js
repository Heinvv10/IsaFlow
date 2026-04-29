// ABSA Business Banking scraper. Runs as a content script in the user's
// authenticated ib.absa.co.za tab.
//
// ABSA exposes a Java-style RPC over JSON at /axob/<Service><Operation>.exp
// that's used by their own SPA. Our scraper calls the same endpoints,
// piggy-backing on the user's existing session cookies. No bank
// credentials ever touch the extension.
//
// Endpoints used:
//   - BalanceEnquiryFacadeGetAllBalances     → list of accounts
//   - TransactionHistoryFacadeGetTransactionHistory → tx history (180-day cap)
//
// Captured 2026-04-29 with a real Brightsphere ABSA session via Playwright
// MCP. Fixtures in tests/unit/accounting/fixtures/absa/.

(function () {
  const SCRAPER_ID = 'absa';
  const SCRAPER_VERSION = '1.0.0';
  const BASE = 'https://ib.absa.co.za';
  const MAX_RANGE_DAYS = 180;

  // Register with the service worker so it knows this tab can scrape ABSA.
  chrome.runtime.sendMessage(
    { source: 'isaflow-bank', type: 'register-scraper', bankId: SCRAPER_ID, version: SCRAPER_VERSION },
    () => { /* fire-and-forget */ },
  );

  // Receive RPCs from the service worker.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== 'isaflow-bank') return false;

    const handlers = {
      isAuthenticated: () => isAuthenticated(),
      listAccounts: () => listAccounts(),
      fetchTransactions: () => fetchTransactions(msg.accountNumber, msg.fromDate, msg.toDate),
      ping: () => Promise.resolve({ version: SCRAPER_VERSION }),
    };
    const fn = handlers[msg.type];
    if (!fn) return false;

    fn().then(
      (value) => sendResponse({ ok: true, value }),
      (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }),
    );
    return true; // async
  });

  // ── RPC handlers ───────────────────────────────────────────────────────────

  async function isAuthenticated() {
    const json = await callExp('BalanceEnquiryFacade', 'GetAllBalances', {}).catch(() => null);
    return Boolean(json && json.header && json.header.statuscode === '0');
  }

  async function listAccounts() {
    const json = await callExp('BalanceEnquiryFacade', 'GetAllBalances', {});
    if (!json || !Array.isArray(json.accountList)) {
      throw new Error('Unexpected BalanceEnquiry response');
    }
    return json.accountList.map(absaAccountToSummary);
  }

  async function fetchTransactions(accountNumber, fromDate, toDate) {
    if (!accountNumber) throw new Error('accountNumber is required');
    if (!fromDate || !toDate) throw new Error('fromDate and toDate are required (YYYY-MM-DD)');

    if (daysBetween(fromDate, toDate) > MAX_RANGE_DAYS) {
      throw new Error(`Date range exceeds ABSA's 180-day server-side cap. Sync in chunks.`);
    }

    const json = await callExp('TransactionHistoryFacade', 'GetTransactionHistory', {
      fromAccountNr: accountNumber,
      fromDate: fromDate + ' 00:00',
      toDate: toDate + ' 00:00',
      sortColumn: 'transactionDate',
      sortDirection: 'DESC',
      unclearedTransactions: false,
      filterValues: null,
    });

    if (!json || !json.transactionHistory || !Array.isArray(json.transactionHistory.accountHistoryLines)) {
      throw new Error('Unexpected TransactionHistory response');
    }
    const lines = json.transactionHistory.accountHistoryLines;
    return { transactions: lines.map(absaLineToParsed), rawCount: lines.length };
  }

  // ── ABSA RPC envelope ──────────────────────────────────────────────────────

  /**
   * Build the ABSA `header` envelope. The bank's SPA fills these from a
   * global state object; we read what we can from cookies and let the
   * server reject (with a clear error) if we miss something. Most fields
   * are repeated back by the server in its response.
   */
  function buildHeader(service, operation) {
    return {
      statuscode: '0',
      userAgent: navigator.userAgent,
      wfpt: readGlobal('wfpt') || '',
      jsessionid: readCookie('JSESSIONID') || '',
      esessionid: readCookie('ESESSIONID') || '',
      xfpt: readGlobal('xfpt') || '',
      service,
      operation,
      channel: 'I',
      timestamp: nowTimestamp(),
      sourceip: '',
      accessAccount: readGlobal('accessAccount') || '',
      userNumber: readGlobal('userNumber') || '',
      nonce: '',
      language: 'en',
      organization: 'ABSA',
      brand: 'ABSA',
      applicationId: null,
      applicationKeyId: null,
      requestToken: null,
      resultMessages: [],
      paginationContext: null,
      reasonCode: null,
    };
  }

  async function callExp(service, operation, body) {
    const url = `${BASE}/axob/${service}${operation}.exp`;
    const payload = { ...body, header: buildHeader(service, operation) };
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`ABSA ${service}.${operation} returned HTTP ${resp.status}`);
    }
    const json = await resp.json();
    const sc = json && json.header && json.header.statuscode;
    if (sc && sc !== '0') {
      const messages = (json.header.resultMessages || []).map(m => m.responseMessage).join('; ');
      throw new Error(`ABSA ${service}.${operation} statuscode=${sc} ${messages || ''}`.trim());
    }
    return json;
  }

  // ── Field mappers (ABSA → IsaFlow canonical shapes) ──────────────────────
  //
  // IMPORTANT — KEEP IN SYNC WITH absaScraperMapper.ts
  // These functions duplicate src/modules/accounting/services/bank/absaScraperMapper.ts
  // because Chrome extensions cannot import TypeScript modules. The TS file is the
  // source of truth and is covered by unit tests. If you change the mapping logic
  // in either place, update the other immediately and run the unit tests.

  function absaAccountToSummary(a) {
    const accountType = (a.accountType || '').toLowerCase();
    let type = 'other';
    if (accountType === 'current') type = 'cheque';
    else if (accountType === 'savings') type = 'savings';
    else if (accountType.includes('credit')) type = 'credit_card';
    else if (accountType.includes('loan')) type = 'loan';
    return {
      externalAccountId: String(a.number),
      accountNumber: String(a.number),
      displayName: a.name || `Account ${a.number}`,
      type,
      currency: 'ZAR',
      available: a.available != null ? Number(a.available) : null,
      balance: a.balance != null ? Number(a.balance) : null,
    };
  }

  function absaLineToParsed(line) {
    const desc = String(line.transactionDescription || '').replace(/\s+/g, ' ').trim();
    const out = {
      transactionDate: String(line.transactionDate),
      amount: Number(line.transactionAmount),
      description: desc || '(no description)',
    };
    if (line.descriptionLine2 && String(line.descriptionLine2).trim()) {
      out.reference = String(line.descriptionLine2).replace(/\s+/g, ' ').trim();
    }
    if (line.balanceAmount != null) out.balance = Number(line.balanceAmount);
    return out;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Read a global ABSA state field (wfpt / xfpt / accessAccount / userNumber).
   * The bank's SPA stuffs these into a few likely places; we probe each.
   * If none are found, the server may still accept the call (it has the
   * session cookie), so we return ''. */
  function readGlobal(key) {
    try {
      // Common patterns observed in the SPA bundle.
      if (window.__absa && window.__absa[key]) return String(window.__absa[key]);
      if (window.absaState && window.absaState[key]) return String(window.absaState[key]);
      if (window.headerContext && window.headerContext[key]) return String(window.headerContext[key]);
      // Some SPAs stash it in sessionStorage.
      const ss = window.sessionStorage && window.sessionStorage.getItem(key);
      if (ss) return String(ss);
    } catch (_e) { /* sealed window or sandbox */ }
    return '';
  }

  function nowTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
  }

  function daysBetween(fromIso, toIso) {
    const f = Date.parse(fromIso);
    const t = Date.parse(toIso);
    if (isNaN(f) || isNaN(t)) return Number.POSITIVE_INFINITY;
    return Math.floor((t - f) / 86_400_000);
  }
})();
