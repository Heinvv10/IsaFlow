import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';

const rowsOf = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, name: `S${from + i}` }));
const ok = (suppliers: unknown[], total?: number) =>
  new Response(JSON.stringify({ success: true, data: { suppliers, total } }), { status: 200 });
const pageOf = (url: unknown) => Number(new URL(String(url), 'http://x').searchParams.get('page'));

afterEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(log.warn).mockReset(); });

describe('fetchAllSuppliers', () => {
  it('a 4xx surfaces the server message', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'No access to suppliers' } }), { status: 403 }));
    await expect(fetchAllSuppliers()).rejects.toThrow('No access to suppliers');
  });

  it('pages past the 200-row cap and returns every supplier', async () => {
    const ALL = rowsOf(0, 450);
    vi.mocked(apiFetch).mockImplementation(async (url) => ok(ALL.slice((pageOf(url) - 1) * 200, pageOf(url) * 200), ALL.length));
    const r = await fetchAllSuppliers();
    expect(r.suppliers.length).toBe(450);
    expect(r.truncated).toBe(false);
  });

  it('de-duplicates a row that appears on two pages', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      pageOf(url) === 1 ? ok(rowsOf(0, 200)) : ok(rowsOf(199, 5)));
    const r = await fetchAllSuppliers();
    expect(r.suppliers.length).toBe(204);
  });

  it('flags and logs truncation when the page cap stops the walk', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => ok(rowsOf((pageOf(url) - 1) * 200, 200), 1_000_000));
    const r = await fetchAllSuppliers();
    expect(r.truncated).toBe(true);
    expect(r.suppliers.length).toBe(50 * 200);
    expect(log.warn).toHaveBeenCalled();
  });

  it('throws when the route fails instead of returning a silently short list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(fetchAllSuppliers()).rejects.toThrow('Could not load the suppliers - try again');
  });

  it('throws when the body is not JSON', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(fetchAllSuppliers()).rejects.toThrow();
  });
});
