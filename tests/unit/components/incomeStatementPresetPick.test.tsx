// P&L preset pill: sets both dates, drops refused text even when the date is unchanged, and the run asks for that range.
import { pickKit } from '../../helpers/kitSelect';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { typeDate } from '../helpers/dateFields';
import { presetRange } from '@/lib/fiscalRangePresets';
import { todayInSast } from '@/lib/saDateParser';

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
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', loading: false, activeCompany: { id: 'c1', financialYearStart: 3 } }) }));
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

/** Let every queued microtask, effect and 0 ms timer run, inside act: after it, nothing already scheduled is pending. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}


const from = () => screen.getByRole('textbox', { name: 'From' }) as HTMLInputElement;

it('a pill sets both dates and asks for that range; over refused text it drops the text', async () => {
  render(<IncomeStatementPage />);
  const pill = () => screen.getByRole('button', { name: 'Last financial year' }) as HTMLButtonElement;
  await waitFor(() => expect(pill().disabled).toBe(false));
  const want = presetRange('last_fy', todayInSast(), 3)!;
  fireEvent.click(pill());
  await settle();
  await waitFor(() => expect(lastParams().get('period_start')).toBe(want.from));
  expect(lastParams().get('period_end')).toBe(want.to);
  // Refuse text, then pick the same range again: no date changes, so only the reset can drop the text.
  typeDate(from(), 'zz');
  await waitFor(() => expect(from().getAttribute('aria-invalid')).toBe('true'));
  fireEvent.click(pill());
  await settle();
  expect(from().getAttribute('aria-invalid')).toBe('false');
  expect(from().value).not.toBe('zz');
  expect(pill().getAttribute('aria-pressed')).toBe('true');
});
