/** #1695 review: fetchAllPages never reports a complete list it did not read, and readPage treats a missing total as unknown. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { fetchAllPages, fetchAllPayments, MAX_PAGES, PAYMENT_PAGE_SIZE } from '@/components/accounting/allocations/openInvoiceFetch';

const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(from + i) }));
const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response;

describe('fetchAllPages: total not reached', () => {
  it('an empty page before total is reached is truncated, not complete', async () => {
    const out = await fetchAllPages(async i => ({ rows: i === 0 ? mk(0, 2) : [], total: 9 }));
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });
  it('an empty first page with total 0 is complete', async () => {
    expect(await fetchAllPages(async () => ({ rows: [], total: 0 }))).toMatchObject({ rows: [], truncated: false });
  });
});

describe('fetchAllPages: unknown total', () => {
  it('keeps fetching until an empty page, whatever the page size', async () => {
    const pages = [mk(0, 3), mk(3, 3), mk(6, 1), []];
    let calls = 0;
    const out = await fetchAllPages(async i => { calls++; return { rows: pages[i] ?? [], total: null }; });
    expect(out.rows).toHaveLength(7);
    expect(out).toMatchObject({ total: 7, truncated: false });
    expect(calls).toBe(4);
  });
  it('flags truncated when non-empty pages run into the page cap', async () => {
    const out = await fetchAllPages(async i => ({ rows: mk(i * 3, 3), total: null }), 4);
    expect(out.rows).toHaveLength(12);
    expect(out.truncated).toBe(true);
  });
});

describe('fetchAllPages: an endpoint that ignores offset', () => {
  it('stops as soon as a page adds no new ids, truncated, instead of repeating to the cap (unknown total)', async () => {
    let calls = 0;
    const out = await fetchAllPages(async () => { calls++; return { rows: mk(0, 3), total: null }; });
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(true);
    expect(calls).toBe(2); // page 1 is new, page 2 repeats it
  });
  it('the same with a known total it can never reach', async () => {
    let calls = 0;
    const out = await fetchAllPages(async () => { calls++; return { rows: mk(0, 3), total: 99 }; });
    expect(out).toMatchObject({ total: 99, truncated: true });
    expect(calls).toBe(2);
  });
});

describe('readPage via fetchAllPayments: a response without total', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());
  it('a bare array carries no paging envelope: it is the whole list, one request', async () => {
    vi.mocked(apiFetch).mockResolvedValue(reply(mk(0, 3)));
    const out = await fetchAllPayments('supplier', 'x');
    expect(out).toMatchObject({ total: 3, truncated: false });
    expect(out.rows).toHaveLength(3);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
  });
  it('does not stop after page 1, even when the server caps a page below the limit asked for', async () => {
    const cap = PAYMENT_PAGE_SIZE / 2; // the server answers 100 to limit=200
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(reply({ payments: mk(0, cap) }))
      .mockResolvedValueOnce(reply({ payments: mk(cap, cap) }))
      .mockResolvedValueOnce(reply({ payments: mk(2 * cap, 5) }))
      .mockResolvedValueOnce(reply({ payments: [] }));
    const out = await fetchAllPayments('supplier', 'x');
    expect(out.rows).toHaveLength(2 * cap + 5);
    expect(out.truncated).toBe(false);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(4);
  });
  it('is truncated when every page stays non-empty to the cap', async () => {
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => reply({ payments: mk(PAYMENT_PAGE_SIZE * n++, PAYMENT_PAGE_SIZE) }));
    const out = await fetchAllPayments('customer', 'x');
    expect(out.truncated).toBe(true);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(MAX_PAGES);
  });
});
