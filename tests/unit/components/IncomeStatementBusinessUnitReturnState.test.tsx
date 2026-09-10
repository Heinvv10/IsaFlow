import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string | string[]>, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: {prior:false, budget:false, trend:false, variance:false}, setColumns:vi.fn(),
    apply:(rows:StatementRow[]) => rows, budgetState:{status:'idle'},
    companyWideUnavailable:false, trendFailed:false,
  }),
}));

const report = {
  revenue:[], otherIncome:[], costOfSales:[], operatingExpenses:[], otherExpenses:[],
  totalRevenue:0, totalOtherIncome:0, totalCostOfSales:0, totalOperatingExpenses:0,
  totalOtherExpenses:0, grossProfit:0, operatingProfit:0, netProfit:0,
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify({data}), {status});
const reportParams = () => vi.mocked(apiFetch).mock.calls
  .filter(([url]) => String(url).includes('reports-income-statement'))
  .map(([url]) => new URL(String(url), 'http://localhost').searchParams);

beforeEach(() => {
  route.query = {};
  vi.mocked(apiFetch).mockReset().mockImplementation(async url => {
    const path = String(url);
    if (path.includes('business-units')) return response(null, 503);
    if (path.includes('cost-centres')) return response({items:[]});
    if (path.includes('fiscal-periods')) return response(null);
    return response(report);
  });
});
afterEach(cleanup);

it('restores late-hydrated BU state and keeps an unavailable selection visible', async () => {
  const view = render(<IncomeStatementPage />);
  await waitFor(() => expect(reportParams().length).toBeGreaterThan(0));

  route.query = {
    period_start:'2026-04-01', period_end:'2026-04-30',
    business_unit_id:'20000000-0000-4000-8000-000000000001',
  };
  view.rerender(<IncomeStatementPage />);

  expect(await screen.findByDisplayValue('Selected Business Unit (unavailable)')).toBeInTheDocument();
  await waitFor(() => expect(reportParams().at(-1)?.get('business_unit_id'))
    .toBe('20000000-0000-4000-8000-000000000001'));
});
