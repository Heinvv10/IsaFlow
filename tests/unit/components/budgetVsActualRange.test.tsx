/**
 * The Budget vs Actual page shows the period the report covers and drills into
 * exactly that range (the API's `period`), not a calendar-year guess, so a
 * drill-down foots to its report line for a March-February or 14-month year.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

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

const report = (period: string) => ({
  report: {
    period, total_budget: 10, total_actual: 5, total_variance: 5,
    lines: [{ account_code: '4000', account_name: 'Sales', account_type: 'revenue', budget_amount: 10, actual_amount: 5, variance: 5, variance_pct: 50 }],
  },
});

describe('budget vs actual page range', () => {
  it('drills into the report period and shows it', async () => {
    script(() => ok(report('2026-03-01 to 2027-02-28')));
    render(<BudgetVsActualPage />);
    await screen.findByText('Sales');
    expect(screen.getByTestId('report-period').textContent).toMatch(/1 March 2026.*28 February 2027/);
    fireEvent.click(screen.getByText('Sales'));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2026-03-01|2027-02-28');
  });

  it('a 14-month window drills across both years', async () => {
    script(() => ok(report('2026-01-01 to 2027-02-28')));
    render(<BudgetVsActualPage />);
    fireEvent.click(await screen.findByText('Sales'));
    expect(screen.getByTestId('drill').textContent).toBe('4000|2026-01-01|2027-02-28');
  });
});
