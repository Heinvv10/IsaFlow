/**
 * Budgets P3 PR-B (T9): the Budget vs Actual page on the tracking engine.
 * The controls make the query string (period, its own parameters only, the
 * version while it applies, the explicit-level filter); the notices word the
 * engine's; the version picker is disabled, with its reason, on a window that
 * spans two financial years; a line drills with the report's filter; the
 * exports carry the same window. The figures are the engine's (the fixture is
 * built from its pure modules), and an absent budget prints "—".
 */
import { budgetElsewhereNotice, noBudgetYearNotice } from '@/modules/accounting/services/budgets/tracking/trackingNoticeText';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';
import { trackingReport, YEARS, type FixtureRow } from '../helpers/budgetTrackingReportFixture';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(async () => true) }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/charts/ProfitWaterfall', () => ({
  ProfitWaterfall: ({ steps }: { steps: Array<{ label: string }> }) => <div data-testid="waterfall">{steps.map((s) => s.label).join('|')}</div>,
}));
vi.mock('@/components/accounting/charts/VarianceHeatmap', () => ({ VarianceHeatmap: () => <div data-testid="heatmap" /> }));
vi.mock('@/components/accounting/charts/BudgetBulletRow', () => ({
  BudgetBulletRow: ({ lines }: { lines: Array<{ account_name: string }> }) => <div data-testid="bullet">{lines.map((l) => l.account_name).join('|')}</div>,
}));
vi.mock('@/components/accounting/AccountDrillDown', () => ({
  AccountDrillDown: (p: Record<string, string | boolean | undefined>) =>
    <div data-testid="drill" data-tracking={String(p.budgetTracking)} data-return={String(p.returnTo)}>
      {[p.accountCode, p.periodStart, p.periodEnd, p.cc1Id ?? '-', p.cc2Id ?? '-', p.businessUnitId ?? '-'].join('|')}</div>,
}));

import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ROWS: FixtureRow[] = [
  { code: '4000', name: 'Sales', type: 'revenue', actual: 1200, budget: 1000 },
  { code: '4100', name: 'Other income', type: 'revenue', actual: 300 },
  { code: '6000', name: 'Rent', type: 'expense', actual: 800, budget: 500 },
];
const CC1 = '11111111-1111-4111-8111-111111111111';
const BU = '33333333-3333-4333-8333-333333333333';
const VERSIONS = [
  { id: 'v-reforecast', fiscalYear: 2027, name: 'Reforecast 1', kind: 'reforecast', status: 'draft', isPrimary: false },
  { id: 'v-primary', fiscalYear: 2027, name: 'Original budget', kind: 'original', status: 'approved', isPrimary: true },
];
const CENTRES = [
  { id: CC1, code: 'FNO-A', name: 'Fibre North', ccType: 'cc1' },
  { id: '22222222-2222-4222-8222-222222222222', code: 'PRJ-1', name: 'Project One', ccType: 'cc2' },
];
const UNITS = [{ id: BU, code: 'BU-1', name: 'Retail' }];

/** Answer the report, the versions and the dimension lists; `report(q)` builds the report for a query. */
function serve(report: (q: URLSearchParams) => unknown = () => trackingReport(ROWS)) {
  script((u) => {
    if (u.includes('reports-budget-tracking')) return ok(report(new URL(u, 'http://x').searchParams));
    if (u.includes('budget-versions')) return ok({ items: VERSIONS });
    if (u.includes('cost-centres')) return ok({ items: CENTRES });
    if (u.includes('business-units')) return ok({ items: UNITS });
    return undefined;
  });
}
const reportQueries = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u))
  .filter((u) => u.includes('reports-budget-tracking')).map((u) => new URL(u, 'http://x').searchParams);
const lastQuery = () => Object.fromEntries(reportQueries().at(-1)!.entries());
const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('budget vs actual tracking page: controls → query string', () => {
  it('opens on year to date, asking for the bullets, and renders the engine rows with "—" for no budget', async () => {
    serve();
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(lastQuery()).toEqual({ period: 'ytd', group_by: 'cc1' });
    const other = screen.getByRole('button', { name: /Other income/ }).closest('tr')!;
    expect(other.querySelector('[title="No budget"]')?.textContent).toBe('—');
    expect(screen.getByText('Projected FY').getAttribute('title'))
      .toBe('Projected FY2027 = actuals to 30 September 2026 + budget Oct 2026–Feb 2027; a later month with no budget counts its posted actuals');
    expect(screen.getByTestId('posted-through').textContent).toBe('October 2026 is in progress; actuals posted through 26 October 2026');
  });

  it('month sends only month; quarter sends the year and quarter; custom sends from and to', async () => {
    // A window other than the month holding today, so "the months on screen" is not today's month.
    const shown = trackingReport(ROWS);
    serve(() => ({ ...shown, window: { ...shown.window, months: ['2026-04', '2026-05', '2026-06'] } }));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    change('bva-period', 'month');
    change('bva-month', '2026-08');
    await waitFor(() => expect(lastQuery()).toEqual({ period: 'month', month: '2026-08', group_by: 'cc1' }));

    change('bva-period', 'quarter');
    change('report-year', '2026');
    change('bva-quarter', '2');
    await waitFor(() => expect(lastQuery()).toEqual({ period: 'quarter', fiscal_year: '2026', quarter: '2', group_by: 'cc1' }));

    // Custom opens on the months on screen, and sends neither the year nor the month chosen earlier.
    change('bva-period', 'custom');
    await waitFor(() => expect(lastQuery()).toEqual({ period: 'custom', from: '2026-04', to: '2026-06', group_by: 'cc1' }));
  });

  it('a 14-month year offers Q5 (2 months)', async () => {
    serve(() => trackingReport(ROWS, { years: [{ fiscalYear: 2027, startDate: '2026-01-01', endDate: '2027-02-28', kind: 'transition' }] }));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    change('bva-period', 'quarter');
    const quarters = Array.from((screen.getByTestId('bva-quarter') as HTMLSelectElement).options).map((o) => o.text);
    expect(quarters).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5 (2 months)']);
  });

  it('forwards the chosen version, and drops it once the window leaves its year', async () => {
    serve();
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    await waitFor(() => expect((screen.getByTestId('bva-version') as HTMLSelectElement).options).toHaveLength(2));
    expect((screen.getByTestId('bva-version') as HTMLSelectElement).options[0]!.text).toBe('Primary: Original budget');
    change('bva-version', 'v-reforecast');
    await waitFor(() => expect(lastQuery()).toEqual({ period: 'ytd', version_id: 'v-reforecast', group_by: 'cc1' }));
    change('report-year', '2026');
    await waitFor(() => expect(lastQuery()).toEqual({ period: 'ytd', fiscal_year: '2026', group_by: 'cc1' }));
  });

  it('sends the explicit-level filter, and then no group_by (the route refuses the two together)', async () => {
    serve();
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    await waitFor(() => expect(screen.getByTestId('bva-cc1').querySelectorAll('option')).toHaveLength(2));
    // A CC2 centre is not offered as a CC1.
    expect(screen.getByTestId('bva-cc1').textContent).not.toContain('Project One');
    change('bva-cc1', CC1);
    change('bva-bu', BU);
    await waitFor(() => expect(lastQuery()).toEqual({ period: 'ytd', cc1_id: CC1, bu_id: BU }));
  });
});

describe('budget vs actual tracking page: version picker across years', () => {
  it('is disabled when the engine reports a cross-year window (versionsByFy), says why, and the version is dropped', async () => {
    const v = { name: 'Original budget', kind: 'original', status: 'approved' };
    serve((q) => trackingReport(ROWS, q.get('period') === 'custom'
      ? { versionsByFy: { 2026: { id: 'v26', ...v }, 2027: { id: 'v-primary', ...v } } } : {}));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    await waitFor(() => expect((screen.getByTestId('bva-version') as HTMLSelectElement).options).toHaveLength(2));
    change('bva-version', 'v-reforecast');
    change('bva-period', 'custom');
    change('bva-from', '2026-01');
    change('bva-to', '2026-05');
    await waitFor(() => expect(lastQuery()).toEqual({ period: 'custom', from: '2026-01', to: '2026-05', group_by: 'cc1' }));
    // The request is sent before its response renders: wait for the disabled picker itself (review r2 N1).
    await waitFor(() => expect((screen.getByTestId('bva-version') as HTMLSelectElement).disabled).toBe(true));
    expect(screen.getByTestId('bva-version-reason').textContent)
      .toBe('This window spans FY2026 and FY2027: each year reads its own primary version.');
    expect(YEARS.map((y) => y.fiscalYear)).toEqual([2026, 2027]);
    // Back to one year: the picker is enabled again, on the primary.
    change('bva-period', 'ytd');
    await waitFor(() => expect((screen.getByTestId('bva-version') as HTMLSelectElement).disabled).toBe(false));
    expect((screen.getByTestId('bva-version') as HTMLSelectElement).value).toBe('');
  });
});

describe('budget vs actual tracking page: notices', () => {
  it('words the engine notices: no budget for a year, partial budget, unbudgeted actuals', async () => {
    serve(() => trackingReport(ROWS, {
      notices: {
        unbudgetedCount: 1, unbudgetedActual: { income: 300, expense: 0 }, unallocatedBudget: null, noVersion: false,
        partialBudget: { count: 2, actual: { income: 10, expense: 20 } }, noVersionYears: [2028], noBudgetAtFilterYears: [2027],
      },
      version: { id: 'v-reforecast', name: 'Reforecast 1', kind: 'reforecast', status: 'draft', isPrimary: false },
    }));
    render(<BudgetVsActualPage />);
    expect((await screen.findByTestId('bva-no-budget-2028')).textContent)
      .toBe(noBudgetYearNotice(2028));
    // Review r2 (R8): a year whose budget is all at other dimensions is not "no budget".
    expect(screen.getByTestId('bva-budget-elsewhere-2027').textContent).toBe(budgetElsewhereNotice(2027));
    expect(screen.getByTestId('bva-partial-budget').textContent)
      .toBe('2 accounts are budgeted for only part of this window (marked ½): their Budget and variance are shown as —.');
    expect(screen.getByTestId('bva-unbudgeted').textContent).toMatch(/^1 account carry actuals with no budget \(R\s?300\.00 of income actuals\)\.$/);
    expect(screen.getByTestId('bva-version-read').textContent).toBe('Reforecast 1 · draft');
  });

  it('the budget set above a filter is a footer, and "View unfiltered" clears the filter', async () => {
    serve((q) => trackingReport(ROWS, {
      filter: q.get('cc1_id') ? { cc1: { id: CC1, code: 'FNO-A', name: 'Fibre North' } } : {},
      notices: {
        unbudgetedCount: 0, unbudgetedActual: { income: 0, expense: 0 }, noVersion: false, partialBudget: null, noVersionYears: [], noBudgetAtFilterYears: [],
        unallocatedBudget: q.get('cc1_id') ? { income: 0, expense: 250 } : { income: 0, expense: 0 },
      },
    }));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(screen.queryByTestId('bva-unallocated')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('bva-cc1').querySelectorAll('option')).toHaveLength(2));
    change('bva-cc1', CC1);
    const footer = await screen.findByTestId('bva-unallocated');
    expect(footer.textContent).toMatch(/R\s?250\.00 of expense budget on these accounts is set above this filter/);
    fireEvent.click(screen.getByRole('button', { name: /View unfiltered/ }));
    await waitFor(() => expect(lastQuery()).toEqual({ period: 'ytd', group_by: 'cc1' }));
  });
});

describe('budget vs actual tracking page: drill, visuals and export', () => {
  const CC2 = CENTRES[1]!.id;
  it.each([
    ['bva-cc1', CC1, 'cc1_id', { cc1: { id: CC1, code: 'FNO-A', name: 'Fibre North' } }, `${CC1}|-|-`],
    ['bva-cc2', CC2, 'cc2_id', { cc2: { id: CC2, code: 'PRJ-1', name: 'Project One' } }, `-|${CC2}|-`],
    ['bva-bu', BU, 'bu_id', { bu: { id: BU, code: 'BU-1', name: 'Retail' } }, `-|-|${BU}`],
  ] as const)('%s: a line drills into its window with the report filter, as the BvA drill', async (picker, id, param, filter, tail) => {
    serve((q) => trackingReport(ROWS, q.get(param) ? { filter } : {}));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    await waitFor(() => expect(screen.getByTestId(picker).querySelectorAll('option').length).toBeGreaterThan(1));
    change(picker, id);
    await waitFor(() => expect(lastQuery()[param]).toBe(id));
    fireEvent.click(await screen.findByRole('button', { name: /Sales/ }));
    const drill = screen.getByTestId('drill');
    expect(drill.textContent).toBe(`4000|2026-10-01|2026-10-31|${tail}`);
    expect(drill.dataset.tracking).toBe('true');
    expect(drill.dataset.return).toBe('undefined');
  });

  it('the Var R cell opens the same drill as the label', async () => {
    serve();
    render(<BudgetVsActualPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the transactions behind the 4000 variance' }));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2026-10-01|2026-10-31|-|-|-');
  });

  it('draws the bridge from budget to actual net profit, and the bullets from the members', async () => {
    serve(() => trackingReport(ROWS, {
      members: [{ memberId: CC1, code: 'FNO-A', name: 'Fibre North', actual: 100, budget: 80, variance: 20, favourable: true }],
    }));
    render(<BudgetVsActualPage />);
    expect((await screen.findByTestId('waterfall')).textContent).toMatch(/^Budget net profit\|.*\|Actual net profit$/);
    expect(screen.getByTestId('bullet').textContent).toBe('FNO-A Fibre North');
    expect(screen.getByTestId('heatmap')).toBeTruthy();
  });

  it('the exports carry the window and filter, not the bullets', async () => {
    serve();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    change('bva-period', 'fy');
    await waitFor(() => expect(lastQuery().period).toBe('fy'));
    await screen.findByRole('button', { name: /Sales/ });
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    fireEvent.click(screen.getByRole('button', { name: /Export Excel/ }));
    expect(open.mock.calls.map(([u]) => u)).toEqual([
      '/api/accounting/budget-tracking-export?format=csv&period=fy',
      '/api/accounting/budget-tracking-export?format=xlsx&period=fy',
    ]);
    open.mockRestore();
  });
});
