/**
 * `public/sw.js` never writes tenant data or authenticated HTML to Cache Storage.
 *
 * Audit 11 Nov 2026 (a.2 S1, Phase 2 P2.3 #1 / P2.4 S1): the worker served
 * `/api/accounting/dashboard-stats` and `/api/accounting/chart-of-accounts`
 * stale-while-revalidate keyed by URL only, and cached every authenticated
 * HTML page for offline replay. Tenant identity lives in a cookie, so the next
 * user or company at the browser was handed the previous one's data.
 *
 * The worker is evaluated in a `vm` context with its globals stubbed and the
 * real install / activate / fetch handlers driven, so behaviour is asserted,
 * not source text.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

interface FakeRequest { url: string; method: string; mode?: string }
interface FakeEvent {
  request: FakeRequest;
  respondWith: (p: unknown) => void;
  waitUntil: (p: unknown) => void;
}
type Handler = (e: FakeEvent) => void;

class FakeResponse {
  constructor(public body: unknown, public init: { status?: number } = {}) {}
  get status(): number { return this.init.status ?? 200; }
}

interface Harness {
  handlers: Record<string, Handler>;
  cachePuts: string[];
  networkFetches: string[];
  addAllArgs: unknown[];
  deletedCaches: string[];
  cacheName: () => string;
  offline: { network: boolean; cachedOffline: unknown };
  keys: string[];
}

function loadWorker(): Harness {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');
  const handlers: Record<string, Handler> = {};
  const cachePuts: string[] = [];
  const networkFetches: string[] = [];
  const addAllArgs: unknown[] = [];
  const deletedCaches: string[] = [];
  const openedNames: string[] = [];
  const offline = { network: true, cachedOffline: undefined as unknown };
  const keys: string[] = [];

  const cache = {
    match: () => Promise.resolve(undefined),
    put: (req: { url: string }) => { cachePuts.push(req.url); return Promise.resolve(); },
    addAll: (list: unknown) => { addAllArgs.push(list); return Promise.resolve(); },
  };

  const sandbox = {
    self: {
      addEventListener: (name: string, fn: Handler) => { handlers[name] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
    },
    caches: {
      open: (name: string) => { openedNames.push(name); return Promise.resolve(cache); },
      keys: () => Promise.resolve([...keys]),
      delete: (name: string) => { deletedCaches.push(name); return Promise.resolve(true); },
      match: (req: unknown) => Promise.resolve(req === '/offline' ? offline.cachedOffline : undefined),
    },
    fetch: (req: { url: string }) => {
      networkFetches.push(req.url);
      if (!offline.network) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        ok: true,
        clone: () => ({}),
        headers: { get: () => 'text/html; charset=utf-8' },
      });
    },
    Response: FakeResponse,
    URL,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    handlers, cachePuts, networkFetches, addAllArgs, deletedCaches, offline, keys,
    cacheName: () => openedNames[0] ?? '',
  };
}

let h: Harness;
let responses: unknown[] = [];

function dispatch(url: string, mode = 'navigate') {
  let responded = false;
  h.handlers['fetch']!({
    request: { url, method: 'GET', mode },
    respondWith: (p) => { responded = true; responses.push(p); },
    waitUntil: () => {},
  });
  return { responded };
}

const ORIGIN = 'https://app.isaflow.co.za';

beforeEach(() => {
  h = loadWorker();
  responses = [];
});

describe('public/sw.js: tenant API data is never cached', () => {
  it.each(['/api/accounting/dashboard-stats', '/api/accounting/chart-of-accounts'])('%s goes straight to the network', async (p) => {
    const { responded } = dispatch(`${ORIGIN}${p}`, 'cors');
    expect(responded).toBe(false);
    await Promise.all(responses);
    expect(h.cachePuts).toEqual([]);
  });
});

describe('public/sw.js: authenticated HTML is never cached', () => {
  it.each(['/accounting', '/accounting/bank-transactions'])('%s is fetched from the network and not stored', async (p) => {
    const url = `${ORIGIN}${p}`;
    expect(dispatch(url).responded).toBe(true);
    await Promise.all(responses);
    expect(h.networkFetches).toContain(url);
    expect(h.cachePuts).toEqual([]);
  });

  it('a query string ending in .js does not turn a page into a cache-first asset', async () => {
    dispatch(`${ORIGIN}/accounting/x?f=a.js`);
    await Promise.all(responses);
    expect(h.cachePuts).toEqual([]);
  });

  it('a non-navigation, non-static GET is left to the browser', () => {
    expect(dispatch(`${ORIGIN}/accounting/some-data`, 'cors').responded).toBe(false);
  });
});

describe('public/sw.js: static assets and offline still work', () => {
  it('caches a build chunk cache-first', async () => {
    const url = `${ORIGIN}/_next/static/chunks/a.js`;
    expect(dispatch(url, 'no-cors').responded).toBe(true);
    await Promise.all(responses);
    expect(h.cachePuts).toEqual([url]);
  });

  it('an offline navigation gets the cached /offline page', async () => {
    const page = new FakeResponse('offline page');
    h.offline.network = false;
    h.offline.cachedOffline = page;
    dispatch(`${ORIGIN}/accounting`);
    expect(await responses[0]).toBe(page);
  });

  it('an offline navigation with no /offline cached gets a 503', async () => {
    h.offline.network = false;
    dispatch(`${ORIGIN}/accounting`);
    const res = await responses[0] as FakeResponse;
    expect(res).toBeInstanceOf(FakeResponse);
    expect(res.status).toBe(503);
  });

  it('install precaches only the offline page and the manifest', async () => {
    const waits: unknown[] = [];
    h.handlers['install']!({ request: { url: '', method: 'GET' }, respondWith: () => {}, waitUntil: (p) => { waits.push(p); } });
    await Promise.all(waits);
    expect(h.addAllArgs).toHaveLength(1);
    expect([...(h.addAllArgs[0] as string[])]).toEqual(['/offline', '/manifest.json']);
  });

  it('activate deletes every cache but the current one', async () => {
    const waits: unknown[] = [];
    h.handlers['install']!({ request: { url: '', method: 'GET' }, respondWith: () => {}, waitUntil: (p) => { waits.push(p); } });
    await Promise.all(waits);
    const current = h.cacheName();
    expect(current).toMatch(/^isaflow-/);
    h.keys.push('isaflow-old-build', current, 'isaflow-v2-legacy');
    h.handlers['activate']!({ request: { url: '', method: 'GET' }, respondWith: () => {}, waitUntil: (p) => { waits.push(p); } });
    await Promise.all(waits);
    expect(h.deletedCaches).toEqual(['isaflow-old-build', 'isaflow-v2-legacy']);
  });
});
