/**
 * The Budget vs Actual page (budgets P0): Revenue / Expenses / Net profit
 * sections, "—" where there is no budget, colour from `favourable` through
 * varianceColor only, and Year to date as the default period.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';
import { bvaBody } from '../helpers/bvaReportFixture';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const FAV = 'rgb(0, 128, 0)';
const UNFAV = 'rgb(200, 0, 0)';
vi.mock('@/components/accounting/charts/ChartFrame', () => ({
  useChartPalette: () => ({ fav: 'rgb(0, 128, 0)', unfav: 'rgb(200, 0, 0)' }),
}));

import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const BODY = bvaBody([
  { code: '4000', name: 'Sales', type: 'revenue', actual: 1200, budget: 1000 },
  { code: '4100', name: 'Other income', type: 'revenue', actual: 300 },
  { code: '6000', name: 'Rent', type: 'expense', actual: 800, budget: 500 },
]);
const REPORT = {
  fiscal_year: 2026, years: [{ fiscalYear: 2026, startDate: '2026-03-01', endDate: '2027-02-28', kind: 'normal' }],
  report: { period: '2026-03-01 to 2026-10-31', ...BODY },
};
const reportUrls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('reports-budget-vs-actual'));

describe('budget vs actual sections', () => {
  it('renders Total revenue, Total expenses, Net profit', async () => {
    script(() => ok(REPORT));
    render(<BudgetVsActualPage />);
    await screen.findByText('Sales');
    const np = screen.getByTestId('bva-total-net_profit');
    // NP budget 1 000 − 500 = 500; actual 1 500 − 800 = 700; movement +200.
    expect(within(np).getByText('Net profit')).toBeTruthy();
    expect(np.textContent).toMatch(/R\s?500\.00.*R\s?700\.00.*R\s?200\.00/);
    expect(within(screen.getByTestId('bva-total-revenue')).getByText('Total revenue')).toBeTruthy();
    expect(within(screen.getByTestId('bva-total-expense')).getByText('Total expenses')).toBeTruthy();
    expect(screen.queryByText(/^Total$/)).toBeNull();
  });

  it('unbudgeted revenue shows — not −100%', async () => {
    script(() => ok(REPORT));
    render(<BudgetVsActualPage />);
    await screen.findByText('Other income');
    expect(screen.getByTestId('bva-pct-4100').textContent).toBe('—');
    expect(screen.getByTestId('bva-line-4100').textContent).not.toMatch(/100\.0%/);
    expect(screen.getByTestId('bva-pct-4100').style.color).toBe('');
    expect(screen.queryByTestId('bva-bar-4100')).toBeNull();
  });

  it('revenue over budget: bar and figure use the favourable colour from varianceColor', async () => {
    script(() => ok(REPORT));
    render(<BudgetVsActualPage />);
    await screen.findByText('Sales');
    expect(screen.getByTestId('bva-variance-4000').style.color).toBe(FAV);
    expect(screen.getByTestId('bva-variance-4000').textContent).toMatch(/R\s?200\.00/);
    expect(screen.getByTestId('bva-pct-4000').textContent).toBe('+20.0%');
    expect(screen.getByTestId('bva-bar-4000').style.backgroundColor).toBe(FAV);
    expect(screen.getByTestId('bva-bar-4000').style.width).toBe('100%');
    // Expense over budget: the printed movement is positive, and it is bad news.
    expect(screen.getByTestId('bva-variance-6000').textContent).toMatch(/R\s?300\.00/);
    expect(screen.getByTestId('bva-variance-6000').style.color).toBe(UNFAV);
    expect(screen.getByTestId('bva-bar-6000').style.backgroundColor).toBe(UNFAV);
    for (const el of document.querySelectorAll('[data-testid^="bva-"]')) {
      expect(el.className).not.toMatch(/text-(red|teal)-400/);
    }
  });

  it('defaults to Year to date and sends period=ytd', async () => {
    script(() => ok(REPORT));
    render(<BudgetVsActualPage />);
    await waitFor(() => expect(reportUrls()[0]).toMatch(/period=ytd$/));
    expect((await screen.findByDisplayValue('Year to date'))).toBeTruthy();
    expect((await screen.findByTestId('posted-through')).textContent).toBe('Actuals posted through 20 October 2026');
  });
});
