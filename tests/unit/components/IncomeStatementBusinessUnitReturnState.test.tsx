import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/components/accounting/IncomeStatementSections', () => ({
  IncomeStatementSections: ({report: value}: {report: {netProfit:number}}) =>
    <div data-testid="net-profit">{value.netProfit}</div>,
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
  route.isReady = true;
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
  route.isReady = false;
  const view = render(<IncomeStatementPage />);
  expect(reportParams()).toHaveLength(0);

  route.query = {
    period_start:'2026-04-01', period_end:'2026-04-30',
    business_unit_id:'20000000-0000-4000-8000-000000000001',
  };
  route.isReady = true;
  view.rerender(<IncomeStatementPage />);

  expect(await screen.findByDisplayValue('Selected Business Unit (unavailable)')).toBeInTheDocument();
  await waitFor(() => expect(reportParams().at(-1)?.get('business_unit_id'))
    .toBe('20000000-0000-4000-8000-000000000001'));
});

it('ignores an older unfiltered report that resolves after the BU report', async () => {
  let resolveUnfiltered!: (value: Response) => void;
  let resolveFiltered!: (value: Response) => void;
  const unfiltered = new Promise<Response>(resolve => { resolveUnfiltered = resolve; });
  const filtered = new Promise<Response>(resolve => { resolveFiltered = resolve; });
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = String(url);
    if (path.includes('business-units')) return response({items:[]});
    if (path.includes('cost-centres')) return response({items:[]});
    if (path.includes('fiscal-periods')) return response(null);
    return new URL(path, 'http://localhost').searchParams.has('business_unit_id')
      ? filtered : unfiltered;
  });

  const view = render(<IncomeStatementPage />);
  await waitFor(() => expect(reportParams()).toHaveLength(1));
  route.query = {business_unit_id:'20000000-0000-4000-8000-000000000001'};
  view.rerender(<IncomeStatementPage />);
  await waitFor(() => expect(reportParams()).toHaveLength(2));

  await act(async () => resolveFiltered(response({...report, netProfit:22})));
  expect(await screen.findByTestId('net-profit')).toHaveTextContent('22');
  await act(async () => resolveUnfiltered(response({...report, netProfit:11})));
  expect(screen.getByTestId('net-profit')).toHaveTextContent('22');
});

it('does not let an obsolete open-period response overwrite restored deep-link dates', async () => {
  let resolvePeriod!: (value: Response) => void;
  const pendingPeriod = new Promise<Response>(resolve => { resolvePeriod = resolve; });
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = String(url);
    if (path.includes('fiscal-periods')) return pendingPeriod;
    if (path.includes('business-units') || path.includes('cost-centres')) return response({items:[]});
    return response(report);
  });
  const view = render(<IncomeStatementPage />);
  route.query = {period_start:'2026-04-01', period_end:'2026-04-30', business_unit_id:'bu-a'};
  view.rerender(<IncomeStatementPage />);
  await waitFor(() => expect(reportParams().at(-1)?.get('period_start')).toBe('2026-04-01'));

  await act(async () => resolvePeriod(response({startDate:'2020-01-01', endDate:'2020-01-31'})));
  expect(screen.getByDisplayValue('2026-04-01')).toBeInTheDocument();
  expect(screen.getByDisplayValue('2026-04-30')).toBeInTheDocument();
  expect(reportParams().at(-1)?.get('business_unit_id')).toBe('bu-a');
});
