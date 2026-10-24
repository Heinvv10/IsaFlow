/**
 * Expanding a Budget vs Actual line fetches that account's transactions ONCE. Next runs `next dev` under
 * React StrictMode (next.config reactStrictMode), which mounts, unmounts and re-mounts an effect: that used
 * to be two requests per expand in the browser.
 */
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a5';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const REPORT = {
  fiscal_year: 2026, years: [{ fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31', kind: 'normal' }],
  report: {
    period: '2026-10-01 to 2026-10-24', total_budget: 10, total_actual: 5, total_variance: 5,
    lines: [{ account_code: '4000', account_name: 'Sales', account_type: 'revenue', budget_amount: 10, actual_amount: 5, variance: 5, variance_pct: 50 }],
  },
};
const DRILL = { accountCode: '4000', accountName: 'Sales', openingBalance: 0, periodNet: 5, closingBalance: 5, transactions: [] };

const drillFetches = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('reports-account-transactions'));

describe('budget vs actual drill-down', () => {
  it('one expand is one request for the account\'s transactions', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      ok(String(url).includes('reports-account-transactions') ? DRILL : REPORT));
    render(<StrictMode><BudgetVsActualPage /></StrictMode>);
    fireEvent.click(await screen.findByText('Sales'));
    await screen.findByText('No transactions in this period');
    // Let any re-render settle: a second request would be made by now.
    await new Promise((r) => setTimeout(r, 50));
    expect(drillFetches()).toHaveLength(1);
  });

  it('a second line expanded is one more request, and collapsing then expanding again is one more', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      ok(String(url).includes('reports-account-transactions') ? DRILL : REPORT));
    render(<StrictMode><BudgetVsActualPage /></StrictMode>);
    const row = await screen.findByText('Sales');
    fireEvent.click(row);
    await screen.findByText('No transactions in this period');
    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByText('No transactions in this period')).toBeNull());
    fireEvent.click(row);
    await screen.findByText('No transactions in this period');
    expect(drillFetches()).toHaveLength(2);
  });
});
