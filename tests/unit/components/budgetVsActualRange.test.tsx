/**
 * The Budget vs Actual page shows the period the report covers and drills into
 * exactly that range (the API's `period`), not a calendar-year guess, so a
 * drill-down foots to its report line for a March-February or 14-month year.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';
import { bvaBody } from '../helpers/bvaReportFixture';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/AccountDrillDown', () => ({
  AccountDrillDown: (p: { accountCode: string; periodStart: string; periodEnd: string }) =>
    <tr><td data-testid="drill">{`${p.accountCode}|${p.periodStart}|${p.periodEnd}`}</td></tr>,
}));

import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const YEARS = [
  { fiscalYear: 2026, startDate: '2026-01-01', endDate: '2027-02-28', kind: 'transition' },
  { fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29', kind: 'normal' },
];
const report = (period: string, fiscalYear = 2026) => ({
  fiscal_year: fiscalYear, years: YEARS,
  report: {
    period, ...bvaBody([{ code: '4000', name: 'Sales', type: 'revenue', actual: 5, budget: 10 }]),
  },
});

describe('budget vs actual page range', () => {
  it('drills into the report period and shows it', async () => {
    script(() => ok(report('2026-03-01 to 2027-02-28')));
    render(<BudgetVsActualPage />);
    await screen.findByText('Sales');
    expect(screen.getByTestId('report-period').textContent).toMatch(/1 March 2026.*28 February 2027/);
    // The tertiary text colour is ~2.4:1 on the light theme; the range line is secondary.
    expect(screen.getByTestId('report-period').className).not.toContain('ff-text-tertiary');
    fireEvent.click(screen.getByText('Sales'));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2026-03-01|2027-02-28');
  });

  it('a 14-month window drills across both years', async () => {
    script(() => ok(report('2026-01-01 to 2027-02-28')));
    render(<BudgetVsActualPage />);
    fireEvent.click(await screen.findByText('Sales'));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2026-01-01|2027-02-28');
  });

  const reportUrls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('reports-budget-vs-actual'));

  it('sends the chosen year, and its range is what the page shows and drills into', async () => {
    script((u) => ok(report(u.includes('fiscal_year=2028') ? '2027-03-01 to 2028-02-29' : '2026-01-01 to 2027-02-28',
      u.includes('fiscal_year=2028') ? 2028 : 2026)));
    render(<BudgetVsActualPage />);
    fireEvent.change(await screen.findByDisplayValue('Year to date'), { target: { value: 'full_year' } });
    const select = (await screen.findByTestId('report-year')) as HTMLSelectElement;
    expect(select.value).toBe('2026');
    expect(Array.from(select.options).map((o) => o.text)).toEqual(['2026: Jan 2026 - Feb 2027', '2028: Mar 2027 - Feb 2028']);
    expect(reportUrls().at(-1)).not.toContain('fiscal_year');

    fireEvent.change(select, { target: { value: '2028' } });
    await waitFor(() => expect(reportUrls().at(-1)).toMatch(/period=full_year&fiscal_year=2028$/));
    await screen.findByText(/1 March 2027/);
    fireEvent.click(screen.getByText('Sales'));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2027-03-01|2028-02-29');

    // Back to the current month: the chosen year is not sent with it.
    fireEvent.change(screen.getByDisplayValue('Full year'), { target: { value: 'current' } });
    await waitFor(() => expect(reportUrls().at(-1)).toMatch(/period=current$/));
  });

  it('this period offers no year and never sends one', async () => {
    script(() => ok(report('2026-10-01 to 2026-10-31')));
    render(<BudgetVsActualPage />);
    fireEvent.change(await screen.findByDisplayValue('Year to date'), { target: { value: 'current' } });
    await waitFor(() => expect(reportUrls().at(-1)).toMatch(/period=current$/));
    await screen.findByText('Sales');
    expect(screen.queryByTestId('report-year')).toBeNull();
    expect(reportUrls().every((u) => !u.includes('fiscal_year'))).toBe(true);
  });

  it('year to date of a year that has not started says when it starts, with no range or lines', async () => {
    script(() => ok({
      fiscal_year: 2028, years: YEARS,
      report: { period: 'not started', ...bvaBody([], null), not_started: true, starts_on: '2027-03-01' },
    }));
    render(<BudgetVsActualPage />);
    expect((await screen.findByTestId('year-not-started')).textContent).toBe('This financial year starts on 1 March 2027');
    expect(screen.getByText(/nothing to show for year to date yet/).className).not.toContain('ff-text-tertiary');
    expect(screen.queryByTestId('report-period')).toBeNull();
    expect(screen.queryByText('No budget data available')).toBeNull();
  });
});
