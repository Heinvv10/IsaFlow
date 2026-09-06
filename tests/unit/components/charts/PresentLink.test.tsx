/**
 * `pages/accounting/reports/present/[pack].tsx` was unreachable: nothing in
 * the app linked to it, and it has no standalone destination — opened without
 * a pack type and a range it can only report "Unknown pack". The statement
 * pages are the entry point, and the link must carry the period the reader is
 * actually looking at, not a default the deck would pick for itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { PresentLink } from '@/components/accounting/reportControls/PresentLink';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const apiJson = vi.fn();
vi.mock('@/lib/apiFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apiFetch')>();
  return { ...actual, apiFetch: vi.fn(), apiJson: (u: string) => apiJson(u) };
});

import { apiFetch } from '@/lib/apiFetch';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import BalanceSheetPage from '@/../pages/accounting/reports/balance-sheet';

const mockedApiFetch = vi.mocked(apiFetch);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function stubFetches() {
  mockedApiFetch.mockImplementation(async (url: string) => {
    if (url.includes('cost-centres')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.includes('fiscal-periods')) return new Response(JSON.stringify({ data: null }), { status: 200 });
    return new Response(JSON.stringify({ data: {
      periodStart: '2026-03-01', periodEnd: '2026-08-31',
      revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
      totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0,
      totalOperatingExpenses: 0, totalOtherExpenses: 0,
      grossProfit: 0, operatingProfit: 0, netProfit: 0,
      assets: [], liabilities: [], equity: [],
      totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
    } }), { status: 200 });
  });
  apiJson.mockResolvedValue({ months: [], byAccountCode: {}, unavailable: {}, lines: [], budgetedCount: 0 });
}

describe('<PresentLink />', () => {
  it('points at the management pack with the range it was given', () => {
    render(<PresentLink from="2026-03-01" to="2026-08-31" />);
    expect(screen.getByRole('link', { name: /Present/ }).getAttribute('href'))
      .toBe('/accounting/reports/present/management?from=2026-03-01&to=2026-08-31');
  });

  it('is inert without both bounds, rather than linking to an "Unknown pack" error', () => {
    render(<PresentLink from="2026-03-01" to="" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Present').closest('[aria-disabled]')).not.toBeNull();
  });
});

describe('the income statement page', () => {
  it('carries the period the reader has chosen into the deck', async () => {
    stubFetches();
    const { container } = render(<IncomeStatementPage />);

    const from = container.querySelector('input[name="periodStart"]');
    if (!from) throw new Error('no period-start input');
    fireEvent.change(from, { target: { value: '2026-04-01' } });

    await waitFor(() => expect(
      screen.getByRole('link', { name: /Present/ }).getAttribute('href'),
    ).toContain('from=2026-04-01'));
    expect(screen.getByRole('link', { name: /Present/ }).getAttribute('href'))
      .toMatch(/^\/accounting\/reports\/present\/management\?from=2026-04-01&to=\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the balance sheet page', () => {
  it('presents the year-to-date window ending at its as-at date', async () => {
    stubFetches();
    const { container } = render(<BalanceSheetPage />);

    const asAt = container.querySelector('input[type="date"]');
    if (!asAt) throw new Error('no as-at input');
    fireEvent.change(asAt, { target: { value: '2026-08-31' } });

    await waitFor(() => expect(
      screen.getByRole('link', { name: /Present/ }).getAttribute('href'),
    ).toBe('/accounting/reports/present/management?from=2026-01-01&to=2026-08-31'));
  });
});
