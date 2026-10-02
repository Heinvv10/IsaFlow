// OCR vendor -> supplier: token choice and scoring across searches (PUR-01 round 1).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { matchVendorSupplier, vendorSearchTokens } from '@/components/accounting/supplier-invoices/matchVendorSupplier';

const SUPPLIERS = [
  { id: 'a', name: 'Widget Works (Pty) Ltd' },
  { id: 'b', name: 'The Widget Shop' },
  { id: 'c', name: '3M South Africa (Pty) Ltd' },
  { id: 'd', name: 'Acme Tools Ltd' },
  { id: 'e', name: 'Acme Building Supplies' },
];
const queries: string[] = [];

function serve() {
  queries.length = 0;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const q = (new URL(String(url), 'http://x').searchParams.get('q') ?? '').toLowerCase();
    queries.push(q);
    const suppliers = SUPPLIERS.filter((s) => s.name.toLowerCase().includes(q));
    return new Response(JSON.stringify({ success: true, data: { suppliers, total: suppliers.length } }), { status: 200 });
  });
}
afterEach(() => vi.mocked(apiFetch).mockReset());

describe('vendorSearchTokens', () => {
  it('skips stopwords and legal suffixes and keeps the longest tokens first', () => {
    expect(vendorSearchTokens('The Widget Works (Pty) Ltd')).toEqual(['widget', 'works']);
  });
  it('keeps short distinctive tokens such as 3M', () => {
    expect(vendorSearchTokens('3M')).toEqual(['3m']);
  });
  it('returns nothing for a name made only of noise', () => {
    expect(vendorSearchTokens('The Pty Ltd CC')).toEqual([]);
  });
});

describe('matchVendorSupplier', () => {
  it('does not search on "The" / "Ltd" and finds the supplier by its distinctive word', async () => {
    serve();
    expect(await matchVendorSupplier('The Widget Shop')).toBe('b');
    expect(queries).not.toContain('the');
    expect(queries).toContain('widget');
  });
  it('matches a short name like 3M', async () => {
    serve();
    expect(await matchVendorSupplier('3M South Africa (Pty) Ltd')).toBe('c');
  });
  it('makes no request when there is nothing distinctive to search', async () => {
    serve();
    expect(await matchVendorSupplier('Pty Ltd')).toBeNull();
    expect(queries).toEqual([]);
  });
  it('prefers a supplier found by every token over one found by a single token', async () => {
    serve();
    // "acme" finds d and e; "tools" finds only d, so d is the one both searches agree on.
    expect(await matchVendorSupplier('Acme Tools')).toBe('d');
  });
  it('returns null when every search fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 500 }));
    expect(await matchVendorSupplier('Acme Tools')).toBeNull();
  });
});
