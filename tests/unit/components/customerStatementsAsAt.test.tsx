/**
 * R-116: the statements pages draw their figures as at the date they show.
 *  - The as-at picker defaults to the LOCAL date: toISOString() is UTC and
 *    named yesterday between 00:00 and 02:00 SAST, and the endpoint now honours
 *    whatever date it is sent.
 *  - The customer drill-down is drawn, labelled and printed as at the date the
 *    balances list was drawn at, not as at today.
 */
process.env.TZ = 'Africa/Johannesburg';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const query: Record<string, string> = {};
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import CustomerStatementsPage from '../../../pages/accounting/customer-statements/index';
import StatementRunPage from '../../../pages/accounting/statement-run/index';
import StatementsPage from '../../../pages/accounting/statements/index';
import CustomerStatementDetailPage from '../../../pages/accounting/customer-statements/[clientId]';

const customer = { client_id: 'c1', client_name: 'Acme', total_invoiced: 100, total_paid: 0, total_credits: 0, balance: 100, invoice_count: 1, last_payment_date: null };
const urls = () => vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));

beforeEach(() => {
  for (const k of Object.keys(query)) delete query[k];
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: RequestInfo | URL) => {
    const u = String(url);
    const data = u.includes('customer-statement-detail')
      ? { client: { id: 'c1', name: 'Acme', email: null, phone: null }, transactions: [{ id: 'i1', date: '2026-08-01', type: 'invoice', reference: 'INV-1', description: '', debit: 100, credit: 0, balance: 100 }], summary: { totalInvoiced: 100, totalPaid: 0, totalCredits: 0, balance: 100 } }
      : u.includes('customer-statements') ? { customers: [customer] } : [];
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('as-at picker default', () => {
  // 23:30 UTC on the 21st is 01:30 SAST on the 22nd.
  const NOW = new Date('2026-09-21T23:30:00Z');
  for (const [name, Page] of [
    ['customer-statements', CustomerStatementsPage],
    ['statement-run', StatementRunPage],
    ['statements', StatementsPage],
  ] as const) {
    it(`${name} asks for the local date, not the UTC one`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      render(<Page />);
      await waitFor(() => expect(urls().some(u => u.includes('/api/accounting/customer-statements?'))).toBe(true));
      const list = urls().find(u => u.includes('/api/accounting/customer-statements?'))!;
      expect(new URL(list, 'http://x').searchParams.get('as_at_date')).toBe('2026-09-22');
    });
  }

  it('statements asks for Overdue as at the same date as the balance', async () => {
    render(<StatementsPage />);
    await waitFor(() => expect(urls().some(u => u.includes('ar-aging'))).toBe(true));
    const list = new URL(urls().find(u => u.includes('/api/accounting/customer-statements?'))!, 'http://x');
    const aging = new URL(urls().find(u => u.includes('ar-aging'))!, 'http://x');
    expect(aging.searchParams.get('as_at_date')).toBe(list.searchParams.get('as_at_date'));
  });
});

describe('customer drill-down', () => {
  it('links from the list carry the as-at date the list was drawn at', async () => {
    render(<CustomerStatementsPage />);
    const link = await screen.findByText('Acme');
    const asAt = new URL(urls().find(u => u.includes('/api/accounting/customer-statements?'))!, 'http://x').searchParams.get('as_at_date');
    expect(link.closest('a')!.getAttribute('href')).toBe(`/accounting/customer-statements/c1?as_at_date=${asAt}`);
  });

  it('draws and labels the statement as at the date it was opened with', async () => {
    Object.assign(query, { clientId: 'c1', as_at_date: '2026-08-31' });
    render(<CustomerStatementDetailPage />);
    await screen.findByText('INV-1');
    const detail = new URL(urls().find(u => u.includes('customer-statement-detail'))!, 'http://x');
    expect(detail.searchParams.get('as_at_date')).toBe('2026-08-31');
    expect(screen.getByText(/Full transaction history as at/).textContent).toMatch(/31/);
  });

  it('with no as-at date asks for none, and the server answers as at today', async () => {
    Object.assign(query, { clientId: 'c1' });
    render(<CustomerStatementDetailPage />);
    await screen.findByText('INV-1');
    const detail = new URL(urls().find(u => u.includes('customer-statement-detail'))!, 'http://x');
    expect(detail.searchParams.has('as_at_date')).toBe(false);
  });
});
