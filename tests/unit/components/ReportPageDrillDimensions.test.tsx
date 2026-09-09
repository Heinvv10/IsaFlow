import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import TrialBalancePage from '@/../pages/accounting/trial-balance';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import BalanceSheetPage from '@/../pages/accounting/reports/balance-sheet';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
vi.mock('@/lib/apiFetch', () => ({apiFetch: vi.fn()}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({rowClass: ''}) }));
vi.mock('next/router', () => ({useRouter: () => ({query: {period_start:'2026-04-01', period_end:'2026-04-30', as_at_date:'2026-04-30'}, pathname: '', push: vi.fn()})}));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({useStatementComparatorState: () => ({columns: {prior:false, budget:false, trend:false, variance:false}, setColumns:vi.fn(), apply:(rows:StatementRow[]) => rows, budgetState:{status:'idle'}, companyWideUnavailable:false, trendFailed:false})}));
const account = {accountCode:'5000', accountName:'Expense', amount:17, balance:17, accountType:'expense', debitBalance:17, creditBalance:0};
const reports = {
  tb: {rows:[account], totalDebit:17, totalCredit:0, difference:17, balanced:false},
  is: {revenue:[], otherIncome:[], costOfSales:[], operatingExpenses:[account], otherExpenses:[], totalRevenue:0, totalOtherIncome:0, totalCostOfSales:0, totalOperatingExpenses:17, totalOtherExpenses:0, grossProfit:0, operatingProfit:-17, netProfit:-17},
  bs: {assets:[account], liabilities:[], equity:[], totalAssets:17, totalLiabilities:0, totalEquity:0},
};
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

it.each([
  ['tb', TrialBalancePage], ['is', IncomeStatementPage], ['bs', BalanceSheetPage],
] as const)('%s carries the selected centre from report through transactions, links and evidence', async (kind, Page) => {
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = String(url);
    const data = path.includes('cost-centres') ? {items:[{id:'centre-a', code:'PROJECT', name:'Project'}]}
      : path.includes('fiscal-periods') ? [{id:'period', periodName:'April', startDate:'2026-04-01', endDate:'2026-04-30', status:'open'}]
      : path.includes('reports-account-transactions') ? {transactions:[]}
      : path.includes('/evidence/') ? {rows:[], count:0}
      : reports[kind];
    return new Response(JSON.stringify({data}));
  });
  render(<Page />);
  await screen.findByRole('option', {name:'PROJECT — Project'});
  fireEvent.change(screen.getByDisplayValue('All Cost Centres'), {target:{value:'centre-a'}});
  if (kind === 'is') fireEvent.click(await screen.findByRole('button', {name:'5000 Expense'}));
  else {
    const link = await screen.findByRole('link', {name:'Expense'});
    expect(new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('cost_centre_id')).toBe('centre-a');
    if (kind === 'tb') fireEvent.click(link.closest('tr')!);
    else fireEvent.click(screen.getByRole('button', {name:'Expand'}));
  }
  const request = (fragment: string) => vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes(fragment)).at(-1)?.[0];
  await waitFor(() => expect(String(request('reports-account-transactions'))).toContain('cost_centre_id=centre-a'));
  fireEvent.click(await screen.findByRole('button', {name:'Evidence'}));
  await screen.findByText('No journal entries found for this period');
  expect(String(request('/evidence/'))).toContain('cost_centre_id=centre-a');
});
