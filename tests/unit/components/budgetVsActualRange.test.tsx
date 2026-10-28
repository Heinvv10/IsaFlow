/**
 * The Budget vs Actual page shows the window the report covers and drills into
 * exactly that window (the engine's `window.startDate` / `endDate`), not a
 * calendar-year guess, so a drill-down foots to its report line for a
 * March-February or 14-month year. The year select sends the chosen label;
 * a month window offers no year and never sends one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';
import { trackingReport } from '../helpers/budgetTrackingReportFixture';
import type { BudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(async () => true) }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/budgets/tracking/BudgetTrackingVisuals', () => ({ BudgetTrackingVisuals: () => null }));
vi.mock('@/components/accounting/AccountDrillDown', () => ({
  AccountDrillDown: (p: { accountCode: string; periodStart: string; periodEnd: string }) =>
    <div data-testid="drill">{`${p.accountCode}|${p.periodStart}|${p.periodEnd}`}</div>,
}));

import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const YEARS = [
  { fiscalYear: 2026, startDate: '2026-01-01', endDate: '2027-02-28', kind: 'transition' },
  { fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29', kind: 'normal' },
];
const SALES = [{ code: '4000', name: 'Sales', type: 'revenue' as const, actual: 5, budget: 10 }];
function report(startDate: string, endDate: string, fiscalYear: number, label: string, extra: Partial<BudgetTrackingReport['window']> = {}) {
  const r = trackingReport(SALES, { years: YEARS });
  return { ...r, window: { ...r.window, period: 'fy' as const, label, startDate, endDate, fiscalYear, inProgress: null, ...extra } };
}
const reportUrls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('reports-budget-tracking'));
const serve = (fn: (u: string) => unknown) => script((u) => (u.includes('reports-budget-tracking') ? ok(fn(u)) : undefined));

describe('budget vs actual page range', () => {
  it('drills into the report window and shows it', async () => {
    serve(() => report('2026-03-01', '2027-02-28', 2027, 'FY2027'));
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(screen.getByTestId('report-period').textContent).toBe('FY2027: 1 March 2026 to 28 February 2027');
    // The tertiary text colour is ~2.4:1 on the light theme; the range line is secondary.
    expect(screen.getByTestId('report-period').className).not.toContain('ff-text-tertiary');
    fireEvent.click(screen.getByRole('button', { name: /Sales/ }));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2026-03-01|2027-02-28');
  });

  it('a 14-month window drills across both calendar years', async () => {
    serve(() => report('2026-01-01', '2027-02-28', 2026, 'FY2026'));
    render(<BudgetVsActualPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Sales/ }));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2026-01-01|2027-02-28');
  });

  it('sends the chosen year, and its window is what the page shows and drills into', async () => {
    serve((u) => (u.includes('fiscal_year=2028')
      ? report('2027-03-01', '2028-02-29', 2028, 'FY2028') : report('2026-01-01', '2027-02-28', 2026, 'FY2026')));
    render(<BudgetVsActualPage />);
    fireEvent.change(await screen.findByDisplayValue('Year to date'), { target: { value: 'fy' } });
    const select = (await screen.findByTestId('report-year')) as HTMLSelectElement;
    expect(select.value).toBe('2026');
    expect(Array.from(select.options).map((o) => o.text)).toEqual(['2026: Jan 2026 - Feb 2027', '2028: Mar 2027 - Feb 2028']);
    await waitFor(() => expect(reportUrls().at(-1)).toMatch(/\?period=fy&group_by=cc1$/));

    fireEvent.change(select, { target: { value: '2028' } });
    await waitFor(() => expect(reportUrls().at(-1)).toMatch(/\?period=fy&fiscal_year=2028&group_by=cc1$/));
    await screen.findByText(/1 March 2027/);
    fireEvent.click(screen.getByRole('button', { name: /Sales/ }));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2027-03-01|2028-02-29');

    // A month window: the chosen year is not sent with it.
    fireEvent.change(screen.getByDisplayValue('Full year'), { target: { value: 'month' } });
    await waitFor(() => expect(reportUrls().at(-1)).toMatch(/\?period=month&group_by=cc1$/));
    expect(screen.queryByTestId('report-year')).toBeNull();
  });

  it('year to date of a year that has not started says when it starts, with no range or lines', async () => {
    serve(() => ({ ...report('2027-03-01', '2027-02-28', 2028, 'FY2028 to date', { notStarted: true, postedThrough: null }), lines: [] }));
    render(<BudgetVsActualPage />);
    expect((await screen.findByTestId('year-not-started')).textContent).toBe('This financial year starts on 1 March 2027');
    expect(screen.getByText(/nothing to show for year to date yet/).className).not.toContain('ff-text-tertiary');
    expect(screen.queryByTestId('report-period')).toBeNull();
    expect(screen.queryByText('No budget or actuals in this window')).toBeNull();
  });
});
