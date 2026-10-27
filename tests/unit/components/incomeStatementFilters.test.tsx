// P&L filters (wave 2 L): To's "eom" counts from From, and the cost-centre and business-unit selects are
// named by their labels.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string | string[]>, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns: { prior: false, budget: false, trend: false, variance: false }, setColumns: vi.fn(),
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
const lastParams = () => {
  const urls = vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('reports-income-statement'));
  return new URL(urls.at(-1) ?? '/', 'http://localhost').searchParams;
};

beforeEach(() => {
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

it('"1 Sep 2026" in From and "eom" in To request 1 to 30 Sep 2026', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-04-30'));
  typeDate(screen.getByRole('textbox', { name: 'From' }), '1 Sep 2026');
  typeDate(screen.getByRole('textbox', { name: 'To' }), 'eom');
  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-09-30'));
  expect(lastParams().get('period_start')).toBe('2026-09-01');
});

it('the cost-centre and business-unit selects are named by their labels', () => {
  render(<IncomeStatementPage />);
  expect(screen.getByRole('combobox', { name: 'Cost Centre' }).tagName).toBe('SELECT');
  expect(screen.getByRole('combobox', { name: 'Business Unit' }).tagName).toBe('SELECT');
});

it('To may not be before From: "-7" from 1 Apr is refused, and no report is requested for it', async () => {
  render(<IncomeStatementPage />);
  await waitFor(() => expect(lastParams().get('period_end')).toBe('2026-04-30'));
  typeDate(screen.getByRole('textbox', { name: 'To' }), '-7');
  expect(await screen.findByText(/on or after 01 Apr 2026/)).toBeTruthy();
  expect(lastParams().get('period_end')).toBe('2026-04-30');
});

it('while a date is refused the old report is not shown and cannot be exported; a valid date brings it back', async () => {
  render(<IncomeStatementPage />);
  const csv = () => screen.getByRole('button', { name: /Export CSV/ }) as HTMLButtonElement;
  await waitFor(() => expect(csv().disabled).toBe(false));
  typeDate(screen.getByRole('textbox', { name: 'From' }), 'garbage');
  await waitFor(() => expect(csv().disabled).toBe(true));
  expect(screen.queryByText(/Profit & Loss —/)).toBeNull();
  typeDate(screen.getByRole('textbox', { name: 'From' }), '1 Apr 2026');
  await waitFor(() => expect(csv().disabled).toBe(false));
});
