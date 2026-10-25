// The REAL Account Detail page, multi-page: the page size is overridden by serving a ledger whose total spans three
// 200-row pages and selecting the page through the router query.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, pathname: '/x', push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import AccountDetailPage from '../../../pages/accounting/reports/account-detail/[accountId]';
import { formatMoney } from '@/lib/money/formatMoney';

const fmt = (n: number) => formatMoney(n);
const meta = { accountId: 'a', accountCode: '4300', accountName: 'Other Income', accountType: 'revenue', normalBalance: 'credit' };
const row = (id: string, credit: number, runningBalance: number, extra = {}) => ({
  journalEntryId: id, entryDate: '2026-04-01', entryNumber: id, description: id, reference: '', source: 'manual',
  debit: 0, credit, runningBalance, ...extra,
});
// Revenue, opening 100: +10 (110), +20 (130) | CLOSE 130 (0), +5 (5) | +7 (12). total 450 rows across 3 pages (size 200).
const pages: Record<string, unknown[]> = {
  '0': [row('A', 10, 110), row('B', 20, 130)],
  '200': [row('CLOSE', 0, 0, { journalEntryId: '', debit: 130, derived: true, source: 'year_end_close' }), row('C', 5, 5)],
  '400': [row('D', 7, 12)],
};
afterEach(() => { vi.unstubAllGlobals(); router.query = {}; });

function show(page: number) {
  router.query = { accountId: '4300', from: '2025-06-01', to: '2026-09-30', page: String(page) };
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const offset = new URL(String(url), 'http://x').searchParams.get('offset') ?? '0';
    return new Response(JSON.stringify({ success: true, data: {
      rows: pages[offset], total: 450, derivedRows: 1, openingBalance: 100, periodNet: 42, closedToRetainedEarnings: -130,
      periodClosingBalance: 12, meta,
    } }), { status: 200 });
  }));
  return render(<AccountDetailPage />);
}
const rowsText = (c: HTMLElement) => Array.from(c.querySelectorAll('tbody tr')).map(tr => tr.textContent ?? '');

describe('Account Detail page boundaries across pages', () => {
  it.each([
    [1, 'Opening Balance', 100, 'Balance Carried Forward', 130],
    [2, 'Balance Brought Forward', 130, 'Balance Carried Forward', 5],
    [3, 'Balance Brought Forward', 5, 'Closing Balance', 12],
  ])('page %i', async (page, openLabel, openValue, closeLabel, closeValue) => {
    const { container } = show(page);
    await screen.findAllByText(closeLabel);
    const r = rowsText(container);
    expect(r[0]).toContain(openLabel);
    expect(r[0]).toContain(fmt(openValue));
    expect(r[r.length - 1]).toContain(closeLabel);
    expect(r[r.length - 1]).toContain(fmt(closeValue));
  }, 10000);

  it('page 2 shows the derived close row italic, labelled, on the debit side', async () => {
    const { container } = show(2);
    await screen.findByText('Balance Brought Forward');
    const derived = Array.from(container.querySelectorAll('tbody tr')).find(tr => tr.textContent?.includes('year_end_close'))!;
    expect(derived.className).toContain('italic');
    expect(derived.textContent).toContain(fmt(130));
  }, 10000);
});
