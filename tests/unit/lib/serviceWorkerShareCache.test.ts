/**
 * `public/sw.js` — the shared pack is never written to a cache.
 *
 * The worker's HTML strategy caches any 200 `text/html` GET and replays it
 * offline. It does not read `Cache-Control`, so `/share/<token>` being served
 * `no-store` bought nothing: a recipient's browser kept the financial pack —
 * and the token inside `__NEXT_DATA__` — on disk, and went on serving it after
 * the sender revoked the link. Revocation is the ONLY control the sender has
 * once a link is out, so a cache that outlives it defeats the whole feature.
 *
 * The file is a plain classic worker script, not a module, so it is evaluated
 * here in a `vm` context with the worker globals stubbed and the real fetch
 * handler driven — the behaviour is asserted, not the source text.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

interface FakeEvent {
  request: { url: string; method: string; mode?: string };
  respondWith: (p: unknown) => void;
  waitUntil: (p: unknown) => void;
}

interface Harness {
  fetchHandler: (e: FakeEvent) => void;
  cachePuts: string[];
  networkFetches: string[];
}

function loadWorker(): Harness {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../public/sw.js'), 'utf8');
  const handlers: Record<string, (e: FakeEvent) => void> = {};
  const cachePuts: string[] = [];
  const networkFetches: string[] = [];

  const cache = {
    match: () => Promise.resolve(undefined),
    put: (req: { url: string }) => { cachePuts.push(req.url); return Promise.resolve(); },
    addAll: () => Promise.resolve(),
  };

  const sandbox = {
    self: {
      addEventListener: (name: string, fn: (e: FakeEvent) => void) => { handlers[name] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
    },
    caches: {
      open: () => Promise.resolve(cache),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
      match: () => Promise.resolve(undefined),
    },
    fetch: (req: { url: string }) => {
      networkFetches.push(req.url);
      return Promise.resolve({
        ok: true,
        clone: () => ({}),
        headers: { get: () => 'text/html; charset=utf-8' },
      });
    },
    Response: class { constructor(public body: unknown, public init: unknown) {} },
    URL,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const fetchHandler = handlers['fetch'];
  if (!fetchHandler) throw new Error('sw.js registered no fetch handler');
  return { fetchHandler, cachePuts, networkFetches };
}

let h: Harness;
const responses: unknown[] = [];

function dispatch(url: string, opts: { method?: string; mode?: string } = {}) {
  let responded = false;
  h.fetchHandler({
    request: { url, method: opts.method ?? 'GET', mode: opts.mode ?? 'navigate' },
    respondWith: (p) => { responded = true; responses.push(p); },
    waitUntil: () => {},
  });
  return { responded };
}

beforeEach(() => {
  h = loadWorker();
  responses.length = 0;
});

describe('public/sw.js — the share page is never cached', () => {
  it('does not intercept a shared pack at all', async () => {
    const { responded } = dispatch('https://app.isaflow.co.za/share/abc123DEF456');
    // No respondWith means the browser's own network fetch, and no cache entry
    // for the worker to serve back after the link is revoked.
    expect(responded).toBe(false);
    await Promise.all(responses);
    expect(h.cachePuts).toEqual([]);
  });

  it('does not cache the bare /share path either', async () => {
    expect(dispatch('https://app.isaflow.co.za/share').responded).toBe(false);
    await Promise.all(responses);
    expect(h.cachePuts).toEqual([]);
  });

  it('still caches an ordinary app page, so the exclusion is not a blanket off-switch', async () => {
    const url = 'https://app.isaflow.co.za/accounting/reports/report-packs';
    expect(dispatch(url).responded).toBe(true);
    await Promise.all(responses);
    expect(h.networkFetches).toContain(url);
    expect(h.cachePuts).toEqual([url]);
  });

  it('keeps /sharepoint and /shared-with-me cached — the boundary is the path segment', async () => {
    const a = 'https://app.isaflow.co.za/sharepoint';
    const b = 'https://app.isaflow.co.za/shared-with-me';
    dispatch(a);
    dispatch(b);
    await Promise.all(responses);
    expect(h.cachePuts).toEqual([a, b]);
  });

  it('does not let a query string smuggle a share path past the check', async () => {
    // The old strategies matched on the URL STRING. The path is what decides.
    const url = 'https://app.isaflow.co.za/accounting/reports?next=/share/abc123';
    dispatch(url);
    await Promise.all(responses);
    expect(h.cachePuts).toEqual([url]);
  });
});
