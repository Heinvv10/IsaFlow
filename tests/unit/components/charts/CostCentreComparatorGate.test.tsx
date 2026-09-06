/**
 * The trend and the budget are COMPANY-WIDE figures.
 *
 * `trendRowsService` applies no cost-centre filter — its own header says so —
 * and `getBudgetVariance` takes no cost centre either. Both statement pages
 * nonetheless kept a cost-centre selector and passed `cost_centre_id` to the
 * statement fetch, so a filtered statement could print a company-wide
 * sparkline and a company-wide budget in the same row as a departmental
 * figure. Nothing in the code prevented it.
 *
 * With a cost centre selected the two columns are switched off, not fetched,
 * and the page says why.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { COMPANY_WIDE_UNAVAILABLE } from '@/components/accounting/reportControls/ComparatorNotices';

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

const COST_CENTRES = { data: [{ id: 'cc-1', code: 'OPS', name: 'Operations' }] };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function stubFetches() {
  mockedApiFetch.mockImplementation(async (url: string) => {
    if (url.includes('cost-centres')) return jsonResponse(COST_CENTRES);
    if (url.includes('fiscal-periods')) return jsonResponse({ data: null });
    return jsonResponse({ data: {
      periodStart: '2026-08-01', periodEnd: '2026-08-31',
      revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
      totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0,
      totalOperatingExpenses: 0, totalOtherExpenses: 0,
      grossProfit: 0, operatingProfit: 0, netProfit: 0,
      assets: [], liabilities: [], equity: [],
      totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
    } });
  });
  apiJson.mockResolvedValue({ months: [], byAccountCode: {}, unavailable: {}, lines: [], budgetedCount: 0 });
}

const comparatorCalls = () =>
  apiJson.mock.calls.map(c => String(c[0]))
    .filter(u => u.includes('reports-account-trends') || u.includes('reports-budget-comparator'));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the income statement with a cost centre selected', () => {
  it('switches the company-wide columns off, fetches neither, and says why', async () => {
    stubFetches();
    render(<IncomeStatementPage />);

    const trend = await screen.findByLabelText('12-month trend') as HTMLInputElement;
    const budget = screen.getByLabelText('Budget') as HTMLInputElement;
    fireEvent.click(trend);
    fireEvent.click(budget);
    await waitFor(() => expect(comparatorCalls().length).toBe(2));
    const beforeFilter = comparatorCalls().length;

    fireEvent.change(await screen.findByDisplayValue('All Cost Centres'), { target: { value: 'cc-1' } });

    expect(await screen.findByText(COMPANY_WIDE_UNAVAILABLE)).toBeInTheDocument();
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Budget') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Budget') as HTMLInputElement).checked).toBe(false);
    // No further trend/budget request was issued for the filtered view.
    expect(comparatorCalls().length).toBe(beforeFilter);
  });

  it(`restores the reader own choice when the cost centre is cleared`, async () => {
    stubFetches();
    render(<IncomeStatementPage />);

    fireEvent.click(await screen.findByLabelText('12-month trend'));
    const select = await screen.findByDisplayValue('All Cost Centres');
    fireEvent.change(select, { target: { value: 'cc-1' } });
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(false);

    fireEvent.change(screen.getByDisplayValue('OPS — Operations'), { target: { value: '' } });
    await waitFor(() =>
      expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByText(COMPANY_WIDE_UNAVAILABLE)).not.toBeInTheDocument();
  });
});

describe('the balance sheet with a cost centre selected', () => {
  it('switches the trend off, fetches none, and says why', async () => {
    stubFetches();
    render(<BalanceSheetPage />);

    fireEvent.click(await screen.findByLabelText('12-month trend'));
    await waitFor(() => expect(comparatorCalls().length).toBe(1));
    const beforeFilter = comparatorCalls().length;

    fireEvent.change(await screen.findByDisplayValue('All Cost Centres'), { target: { value: 'cc-1' } });

    expect(await screen.findByText(COMPANY_WIDE_UNAVAILABLE)).toBeInTheDocument();
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).disabled).toBe(true);
    expect(comparatorCalls().length).toBe(beforeFilter);
  });
});
