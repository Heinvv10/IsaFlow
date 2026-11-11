/**
 * Audit 11 Nov 2026 (a.2 S1): nothing deleted Cache Storage on sign-out or company switch, so tenant
 * API responses and authenticated HTML written by older service workers stayed in the browser for the
 * next user. clearTenantCacheStorage drops every entry in IsaFlow's caches except the public,
 * user-independent ones the worker cannot re-seed after sign-out (/offline, /manifest.json, build assets).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { clearTenantCacheStorage, clearTenantClientState } from '@/lib/auth/clearTenantClientState';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const ORIGIN = 'https://app.isaflow.co.za';

function fakeCaches(store: Record<string, string[]>) {
  const fake = {
    keys: vi.fn(async () => Object.keys(store)),
    open: vi.fn(async (name: string) => ({
      keys: async () => store[name]!.map((u) => new Request(`${ORIGIN}${u}`)),
      delete: async (req: Request) => {
        const p = new URL(req.url).pathname;
        store[name] = store[name]!.filter((u) => u !== p);
        return true;
      },
    })),
  };
  vi.stubGlobal('caches', fake);
  return fake;
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); localStorage.clear(); });

describe('clearTenantCacheStorage', () => {
  it('deletes tenant API and page entries, keeps the offline page, manifest and build assets', async () => {
    const store: Record<string, string[]> = {
      'isaflow-v3-build1': ['/offline', '/manifest.json', '/_next/static/x.js', '/icons/icon-192.png',
        '/api/accounting/chart-of-accounts', '/api/accounting/dashboard-stats', '/accounting', '/accounting/bank-transactions'],
    };
    fakeCaches(store);
    await clearTenantCacheStorage();
    expect(store['isaflow-v3-build1']).toEqual(['/offline', '/manifest.json', '/_next/static/x.js', '/icons/icon-192.png']);
  });

  it('leaves a cache that is not IsaFlow\'s alone', async () => {
    const store: Record<string, string[]> = { 'other-lib': ['/accounting'], 'isaflow-old': ['/accounting'] };
    const fake = fakeCaches(store);
    await clearTenantCacheStorage();
    expect(store['other-lib']).toEqual(['/accounting']);
    expect(store['isaflow-old']).toEqual([]);
    expect(fake.open).not.toHaveBeenCalledWith('other-lib');
  });

  it('resolves when Cache Storage does not exist', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(clearTenantCacheStorage()).resolves.toBeUndefined();
  });

  it('a Cache Storage that throws is reported, not raised', async () => {
    vi.stubGlobal('caches', { keys: vi.fn(async () => { throw new DOMException('denied', 'SecurityError'); }) });
    await expect(clearTenantCacheStorage()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/cache storage/i), expect.anything(), 'auth');
  });
});

describe('clearTenantClientState', () => {
  it('purges the tenant cache entries and still clears the active company', async () => {
    const store: Record<string, string[]> = { 'isaflow-v3-b': ['/offline', '/api/accounting/chart-of-accounts'] };
    fakeCaches(store);
    localStorage.setItem('isaflow_active_company', 'co-1');
    clearTenantClientState();
    expect(localStorage.getItem('isaflow_active_company')).toBeNull();
    await vi.waitFor(() => expect(store['isaflow-v3-b']).toEqual(['/offline']));
  });
});
