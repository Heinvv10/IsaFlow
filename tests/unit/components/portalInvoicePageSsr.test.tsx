/**
 * The customer invoice portal page loads its invoice in getServerSideProps. It used to fetch its own API through
 * NEXT_PUBLIC_APP_URL (the wrong server on a dev port; on production out through Cloudflare, where the route then
 * logged the SERVER's address and user agent as the viewer). It now calls the invoice service in this process, passing
 * the real visitor's request so the read receipt names the visitor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ load: vi.fn(async (..._a: unknown[]) => null as unknown) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@/modules/accounting/services/ar/portalInvoiceService', () => ({ loadPortalInvoice: h.load }));

import { getServerSideProps } from '../../../pages/portal/invoice/[token]';

type Ctx = Parameters<typeof getServerSideProps>[0];
const TOKEN = 'a'.repeat(64);
const req = { headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla/5.0' }, socket: { remoteAddress: '127.0.0.1' } };
const ctx = (token = TOKEN) => ({ params: { token }, req }) as unknown as Ctx;
const invoice = (over: Record<string, unknown> = {}) => ({ invoice_number: 'INV-1', due_date: '2099-01-01', status: 'sent', ...over });

beforeEach(() => {
  h.load.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the page must not fetch its own API'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('portal invoice page getServerSideProps', () => {
  it('loads the invoice in-process with the visitor request, and never fetches', async () => {
    h.load.mockResolvedValueOnce(invoice());
    const res = await getServerSideProps(ctx()) as { props: { invoice: { invoice_number: string }; token: string; isOverdue: boolean } };
    expect(h.load).toHaveBeenCalledWith(TOKEN, req);
    expect(res.props).toMatchObject({ invoice: { invoice_number: 'INV-1' }, token: TOKEN, isOverdue: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('flags an overdue invoice, but not a paid one', async () => {
    h.load.mockResolvedValueOnce(invoice({ due_date: '2000-01-01' }));
    expect(((await getServerSideProps(ctx())) as { props: { isOverdue: boolean } }).props.isOverdue).toBe(true);
    h.load.mockResolvedValueOnce(invoice({ due_date: '2000-01-01', status: 'paid' }));
    expect(((await getServerSideProps(ctx())) as { props: { isOverdue: boolean } }).props.isOverdue).toBe(false);
  });

  it('a token that is not 64 hex characters is not found, without a lookup', async () => {
    expect(await getServerSideProps(ctx('nope'))).toEqual({ notFound: true });
    expect(h.load).not.toHaveBeenCalled();
  });

  it('an unknown invoice is not found', async () => {
    h.load.mockResolvedValueOnce(null);
    expect(await getServerSideProps(ctx())).toEqual({ notFound: true });
  });

  it('a failed lookup is not found, never a crash that shows the customer an error with internals', async () => {
    h.load.mockRejectedValueOnce(new Error('connection refused'));
    expect(await getServerSideProps(ctx())).toEqual({ notFound: true });
  });
});
