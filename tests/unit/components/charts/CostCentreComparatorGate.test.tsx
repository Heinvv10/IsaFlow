/**
 * The trend is a COMPANY-WIDE figure; the budget follows the filter.
 *
 * `trendRowsService` applies no cost-centre filter — its own header says so —
 * so with a dimension selected the trend column is switched off, not fetched,
 * and the page says why. The budget column (budgets P3 PR-C) is fetched with
 * the statement's own filter (`cost_centre_id` either level, `business_unit_id`),
 * so it stays on and is re-read for the filtered view.
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
const BUSINESS_UNITS = { data: [{ id: 'bu-1', code: 'SALES', name: 'Sales' }] };

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function stubFetches() {
  mockedApiFetch.mockImplementation(async (url: string) => {
    if (url.includes('cost-centres')) return jsonResponse(COST_CENTRES);
    if (url.includes('business-units')) return jsonResponse(BUSINESS_UNITS);
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
  // One stub answers both comparators: the trend's fields and the budget comparator's whole response.
  apiJson.mockResolvedValue({
    months: [], byAccountCode: {}, unavailable: {}, lines: [], budgetedCount: 0, budgetAbsentYears: [], windowYears: [],
    unallocatedBudget: { income: 0, expense: 0 }, partialBudgetCount: 0, splitsMonth: false, bands: [],
  });
}

const comparatorCalls = () =>
  apiJson.mock.calls.map(c => String(c[0]))
    .filter(u => u.includes('reports-account-trends') || u.includes('reports-budget-comparator'));
const trendCalls = () => comparatorCalls().filter(u => u.includes('reports-account-trends'));
const budgetCalls = () => comparatorCalls().filter(u => u.includes('reports-budget-comparator'));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the income statement with a cost centre selected', () => {
  it('switches the trend off (not fetched, and says why); the budget stays and is read for the cost centre', async () => {
    stubFetches();
    render(<IncomeStatementPage />);

    const trend = await screen.findByLabelText('12-month trend') as HTMLInputElement;
    const budget = screen.getByLabelText('Budget') as HTMLInputElement;
    fireEvent.click(trend);
    fireEvent.click(budget);
    await waitFor(() => expect(comparatorCalls().length).toBe(2));
    const trendsBefore = trendCalls().length;

    // Wait for the option: changing a select to a value it has no option for
    // leaves it at '' — the cost-centre list is its own fetch (R-138).
    await screen.findByRole('option', { name: 'OPS — Operations' });
    fireEvent.change(screen.getByDisplayValue('All Cost Centres'), { target: { value: 'cc-1' } });

    expect(await screen.findByText(COMPANY_WIDE_UNAVAILABLE)).toBeInTheDocument();
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Budget') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Budget') as HTMLInputElement).checked).toBe(true);
    // The budget is re-read with the statement's filter; the trend is not fetched for the filtered view.
    await waitFor(() => expect(budgetCalls().some(u => u.includes('cost_centre_id=cc-1'))).toBe(true));
    expect(trendCalls().length).toBe(trendsBefore);
  });

  it(`restores the reader own choice when the cost centre is cleared`, async () => {
    stubFetches();
    render(<IncomeStatementPage />);

    fireEvent.click(await screen.findByLabelText('12-month trend'));
    await screen.findByRole('option', { name: 'OPS — Operations' });
    const select = screen.getByDisplayValue('All Cost Centres');
    fireEvent.change(select, { target: { value: 'cc-1' } });
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(false);

    fireEvent.change(screen.getByDisplayValue('OPS — Operations'), { target: { value: '' } });
    await waitFor(() =>
      expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByText(COMPANY_WIDE_UNAVAILABLE)).not.toBeInTheDocument();
  });
});

describe('the income statement with a business unit selected', () => {
  it('switches the trend off without losing the reader choice; the budget is read for the unit', async () => {
    stubFetches();
    render(<IncomeStatementPage />);

    fireEvent.click(await screen.findByLabelText('12-month trend'));
    fireEvent.click(screen.getByLabelText('Budget'));
    await waitFor(() => expect(comparatorCalls().length).toBe(2));

    await screen.findByRole('option', { name: 'SALES — Sales' });
    fireEvent.change(screen.getByDisplayValue('All Business Units'), { target: { value: 'bu-1' } });
    expect(await screen.findByText(COMPANY_WIDE_UNAVAILABLE)).toBeInTheDocument();
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Budget') as HTMLInputElement).disabled).toBe(false);
    await waitFor(() => expect(budgetCalls().some(u => u.includes('business_unit_id=bu-1'))).toBe(true));

    fireEvent.change(screen.getByDisplayValue('SALES — Sales'), { target: { value: '' } });
    await waitFor(() => expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText('Budget') as HTMLInputElement).checked).toBe(true);
  });
});

describe('touching a live checkbox while the gate is on', () => {
  it('does not write the gate own zeros back over the reader choice', async () => {
    // `ComparatorControls` is handed the GATED columns and sends back a whole
    // StatementColumns. Written straight through, this first click would
    // carry `trend: false` into the stored choice and clearing the filter
    // would restore nothing.
    stubFetches();
    render(<IncomeStatementPage />);

    fireEvent.click(await screen.findByLabelText('12-month trend'));
    fireEvent.click(screen.getByLabelText('Budget'));

    await screen.findByRole('option', { name: 'OPS — Operations' });
    const select = screen.getByDisplayValue('All Cost Centres');
    fireEvent.change(select, { target: { value: 'cc-1' } });
    expect(await screen.findByText(COMPANY_WIDE_UNAVAILABLE)).toBeInTheDocument();

    // Prior period stays live under the gate — it is filtered with the
    // statement — so this is a click the reader can really make here.
    fireEvent.click(screen.getByLabelText('Prior period'));

    fireEvent.change(screen.getByDisplayValue('OPS — Operations'), { target: { value: '' } });

    await waitFor(() =>
      expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText('Budget') as HTMLInputElement).checked).toBe(true);
    // And the click made under the gate was kept.
    expect((screen.getByLabelText('Prior period') as HTMLInputElement).checked).toBe(true);
  });
});

describe('the balance sheet with a cost centre selected', () => {
  it('switches the trend off, fetches none, and says why', async () => {
    stubFetches();
    render(<BalanceSheetPage />);

    fireEvent.click(await screen.findByLabelText('12-month trend'));
    await waitFor(() => expect(comparatorCalls().length).toBe(1));
    const beforeFilter = comparatorCalls().length;

    await screen.findByRole('option', { name: 'OPS — Operations' });
    fireEvent.change(screen.getByDisplayValue('All Cost Centres'), { target: { value: 'cc-1' } });

    expect(await screen.findByText(COMPANY_WIDE_UNAVAILABLE)).toBeInTheDocument();
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).disabled).toBe(true);
    expect(comparatorCalls().length).toBe(beforeFilter);
  });
});

describe('the balance sheet with a business unit selected', () => {
  it('switches the company-wide trend off and restores it when cleared', async () => {
    stubFetches();
    render(<BalanceSheetPage />);

    fireEvent.click(await screen.findByLabelText('12-month trend'));
    await waitFor(() => expect(comparatorCalls().length).toBe(1));
    const beforeFilter = comparatorCalls().length;

    await screen.findByRole('option', { name: 'SALES — Sales' });
    fireEvent.change(screen.getByDisplayValue('All Business Units'), {target:{value:'bu-1'}});
    expect(await screen.findByText(COMPANY_WIDE_UNAVAILABLE)).toBeInTheDocument();
    expect((screen.getByLabelText('12-month trend') as HTMLInputElement).disabled).toBe(true);
    expect(comparatorCalls().length).toBe(beforeFilter);

    fireEvent.change(screen.getByDisplayValue('SALES — Sales'), {target:{value:''}});
    await waitFor(() => expect((screen.getByLabelText('12-month trend') as HTMLInputElement).checked).toBe(true));
  });
});
