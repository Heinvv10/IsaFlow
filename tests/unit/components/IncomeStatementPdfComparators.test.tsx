/** The page hands the export the comparator columns it has on, so the PDF can say they are left out. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: { period_start: '2026-04-01', period_end: '2026-04-30' }, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));
const columns = vi.hoisted(() => ({ prior: false, budget: false, trend: false, variance: false }));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({
  useStatementComparatorState: () => ({
    columns, setColumns: vi.fn(), apply: (rows: StatementRow[]) => rows, budgetState: { status: 'idle' },
    companyWideUnavailable: false, trendFailed: false,
  }),
}));
vi.mock('@/components/accounting/IncomeStatementSections', () => ({ IncomeStatementSections: () => <div /> }));

const report = {
  revenue: [], otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 0, totalOtherIncome: 0, totalCostOfSales: 0, totalOperatingExpenses: 0,
  totalOtherExpenses: 0, grossProfit: 0, operatingProfit: 0, netProfit: 0,
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url);
    return new Response(JSON.stringify({ data: path.includes('income-statement') ? report : { items: [] } }), { status: 200 });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  [{ prior: true, budget: true }, 'comparators=prior%2Cbudget'],
  [{ prior: false, budget: false }, ''],
])('with %j on, the PDF opens with %j', async (on, param) => {
  Object.assign(columns, on);
  const open = vi.fn();
  vi.stubGlobal('open', open);
  render(<IncomeStatementPage />);
  const button = screen.getByRole('button', { name: 'Export PDF' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  const url = String(open.mock.calls[0]![0]);
  expect(url).toContain('/api/accounting/income-statement-pdf?');
  if (param) expect(url).toContain(param); else expect(url).not.toContain('comparators');
});
