// P&L: a 400 from the report route shows the server's reason, with no retry advice.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string | string[]>, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));
const comparator = vi.hoisted(() => ({ prior: false }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: { prior: comparator.prior, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
    apply: (rows: StatementRow[]) => rows, budgetState: { status: 'idle' },
    companyWideUnavailable: false, trendFailed: false,
  }),
}));
vi.mock('@/components/accounting/IncomeStatementSections', () => ({ IncomeStatementSections: () => <div /> }));

const report = {
  revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0, totalOperatingExpenses: 0,
  totalOtherExpenses: 0, grossProfit: 0, operatingProfit: 0, netProfit: 0,
};
const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

beforeEach(() => {
  comparator.prior = false;
  route.query = { period_start: '2026-04-01', period_end: '2026-04-30' };
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('business-units')) return response([]);
    if (path.includes('cost-centres')) return response({ items: [] });
    if (path.includes('fiscal-periods')) return response(null);
    return response(report);
  });
});
afterEach(cleanup);


it('a 400 from the route shows the server reason and no "try again"', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('reports-income-statement')) {
      return new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'period_start must be a YYYY-MM-DD date' } }), { status: 400 });
    }
    if (path.includes('business-units')) return response([]);
    if (path.includes('cost-centres')) return response({ items: [] });
    return response(null);
  });
  render(<IncomeStatementPage />);
  await act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });
  await waitFor(() => expect(screen.getByText(/period_start must be a YYYY-MM-DD date/)).toBeTruthy());
  expect(document.body.textContent ?? '').not.toMatch(/try again|reload/i);
});
