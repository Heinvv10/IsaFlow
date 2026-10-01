import { afterEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import TrialBalancePage from '@/../pages/accounting/trial-balance';
import IncomeStatementPage from '@/../pages/accounting/reports/income-statement';
import BalanceSheetPage from '@/../pages/accounting/reports/balance-sheet';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({rowClass: ''}) }));
vi.mock('next/router', () => ({useRouter: () => ({query: {period_start:'2026-04-01', period_end:'2026-04-30', as_at_date:'2026-04-30'}, pathname: '', push: vi.fn()})}));
vi.mock('@/components/accounting/reportControls/useStatementComparatorState', () => ({useStatementComparatorState: () => ({columns: {prior:false, budget:false, trend:false, variance:false}, setColumns:vi.fn(), apply:(rows:StatementRow[]) => rows, budgetState:{status:'idle'}, companyWideUnavailable:false, trendFailed:false})}));
const account = {accountCode:'5000', accountName:'Expense', amount:17, balance:17, accountType:'expense', debitBalance:17, creditBalance:0};
const businessUnit = {id:'business-a', code:'OPS', name:'Operations'};
const reports = {
  tb: {rows:[account], totalDebit:17, totalCredit:0, difference:17, balanced:false},
  is: {revenue:[], otherIncome:[], costOfSales:[], operatingExpenses:[account], otherExpenses:[], totalRevenue:0, totalOtherIncome:0, totalCostOfSales:0, totalOperatingExpenses:17, totalOtherExpenses:0, grossProfit:0, operatingProfit:-17, netProfit:-17},
  bs: {assets:[account], liabilities:[], equity:[], totalAssets:17, totalLiabilities:0, totalEquity:0},
};
afterEach(() => {
  cleanup();
  vi.mocked(apiFetch).mockReset();
  // R-093: `vi.spyOn(window, 'open')` on an ALREADY-spied method returns the
  // SAME spy rather than a fresh one, so without restoring it here the next
  // test's `open` variable is the PRIOR test's spy — still carrying its call
  // history. Under load the click that should add THIS test's own two export
  // calls can land after the report hasn't loaded yet (the Export buttons are
  // `disabled={!report}` and nothing here waits on that), so the click is a
  // silent no-op and the assertion below reads only the leaked prior-test
  // calls instead of failing loudly for what actually happened. Restoring
  // guarantees a clean spy every test, so a report that isn't ready yet shows
  // up as ZERO calls, not someone else's.
  vi.restoreAllMocks();
});

it.each([
  ['tb', TrialBalancePage], ['is', IncomeStatementPage], ['bs', BalanceSheetPage],
] as const)('%s carries the selected centre from report through transactions, links and evidence', async (kind, Page) => {
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = String(url);
    const data = path.includes('cost-centres') ? {items:[{id:'centre-a', code:'PROJECT', name:'Project'}]}
      : path.includes('business-units') ? {items:[businessUnit]}
      : path.includes('fiscal-periods') ? [{id:'period', periodName:'April', startDate:'2026-04-01', endDate:'2026-04-30', status:'open'}]
      : path.includes('reports-account-transactions') ? {transactions:[]}
      : path.includes('/evidence/') ? {rows:[], count:0}
      : reports[kind];
    return new Response(JSON.stringify({data}));
  });
  // A dangling call from a PRIOR iteration/test can still resolve and land in
  // this shared mock's `.mock.calls` after `afterEach`'s reset runs — reading
  // only calls made from this point on makes that leakage impossible rather
  // than merely unlikely, matching R-085's per-test isolation fix.
  const startCallIndex = vi.mocked(apiFetch).mock.calls.length;
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
  const request = (fragment: string) => vi.mocked(apiFetch).mock.calls.slice(startCallIndex).filter(([url]) => String(url).includes(fragment)).at(-1)?.[0];
  await waitFor(() => expect(String(request('reports-account-transactions'))).toContain('cost_centre_id=centre-a'));
  fireEvent.click(await screen.findByRole('button', {name:'Evidence'}));
  await screen.findByText('No journal entries found for this period');
  await waitFor(() => expect(String(request('/evidence/'))).toContain('cost_centre_id=centre-a'));
});

it('income statement carries a selected business unit through report, exports, transactions and evidence', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = String(url);
    const data = path.includes('cost-centres') ? {items:[]}
      : path.includes('business-units') ? {items:[businessUnit]}
      : path.includes('fiscal-periods') ? null
      : path.includes('reports-account-transactions') ? {transactions:[]}
      : path.includes('/evidence/') ? {rows:[], count:0}
      : reports.is;
    return new Response(JSON.stringify({data}));
  });

  const startCallIndex = vi.mocked(apiFetch).mock.calls.length;
  render(<IncomeStatementPage />);
  // Wait for the OPTION, not the select: 'All Business Units' shows before the
  // business-units fetch lands, and changing a select to a value it has no
  // option for leaves it at '' — no BU is ever selected (R-138).
  await screen.findByRole('option', {name:'OPS — Operations'});
  fireEvent.change(screen.getByDisplayValue('All Business Units'), {target:{value:'business-a'}});
  const request = (fragment: string) => vi.mocked(apiFetch).mock.calls
    .slice(startCallIndex).filter(([url]) => String(url).includes(fragment)).at(-1)?.[0];
  await waitFor(() => expect(String(request('reports-income-statement'))).toContain('business_unit_id=business-a'));

  // The Export buttons are `disabled={!report}`, and the waitFor above only
  // proves the report fetch was ISSUED, not that its response has resolved
  // through the two `.then()`s that set `report` into state. Under load that
  // gap is enough for a click to land while the button is still disabled — a
  // silent no-op rather than a failed assertion (R-093).
  await waitFor(() => expect(screen.getByRole('button', {name:'Export CSV'})).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', {name:'Export CSV'}));
  fireEvent.click(screen.getByRole('button', {name:'Export Excel'}));
  // One pattern PER export, both requiring the BU — `arrayContaining` with a
  // single shared `stringContaining` would pass if only ONE export carried
  // it (either could satisfy both the array check and the `toHaveBeenCalledWith`
  // above), silently leaving the other export company-wide (R-093 LOW-2).
  expect(open.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
    expect.stringMatching(/income-statement-export.*business_unit_id=business-a/),
    expect.stringMatching(/income-statement-xlsx.*business_unit_id=business-a/),
  ]));

  fireEvent.click(await screen.findByRole('button', {name:'5000 Expense'}));
  await waitFor(() => expect(String(request('reports-account-transactions'))).toContain('business_unit_id=business-a'));
  fireEvent.click(await screen.findByRole('button', {name:'Evidence'}));
  await screen.findByText('No journal entries found for this period');
  await waitFor(() => expect(String(request('/evidence/'))).toContain('business_unit_id=business-a'));
});

it('balance sheet carries a selected business unit through report, exports, links, transactions and evidence', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = String(url);
    const data = path.includes('cost-centres') ? {items:[]}
      : path.includes('business-units') ? {items:[businessUnit]}
      : path.includes('fiscal-periods') ? {endDate:'2026-04-30'}
      : path.includes('reports-account-transactions') ? {transactions:[]}
      : path.includes('/evidence/') ? {rows:[], count:0}
      : reports.bs;
    return new Response(JSON.stringify({data}));
  });

  const startCallIndex = vi.mocked(apiFetch).mock.calls.length;
  render(<BalanceSheetPage />);
  await screen.findByRole('option', {name:'OPS — Operations'});
  fireEvent.change(screen.getByDisplayValue('All Business Units'), {target:{value:'business-a'}});
  const request = (fragment: string) => vi.mocked(apiFetch).mock.calls
    .slice(startCallIndex).filter(([url]) => String(url).includes(fragment)).at(-1)?.[0];
  await waitFor(() => expect(String(request('reports-balance-sheet'))).toContain('business_unit_id=business-a'));

  // See the matching comment on the income-statement test above: the waitFor
  // only proves the request was ISSUED, not that `report` has been set from
  // its response, and the Export buttons stay disabled until it has (R-093).
  await waitFor(() => expect(screen.getByRole('button', {name:'Export CSV'})).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', {name:'Export CSV'}));
  fireEvent.click(screen.getByRole('button', {name:'Export Excel'}));
  expect(open.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
    expect.stringMatching(/balance-sheet-export.*business_unit_id=business-a/),
    expect.stringMatching(/balance-sheet-xlsx.*business_unit_id=business-a/),
  ]));

  const link = await screen.findByRole('link', {name:'Expense'});
  expect(new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get('business_unit_id')).toBe('business-a');
  fireEvent.click(screen.getByRole('button', {name:'Expand'}));
  await waitFor(() => expect(String(request('reports-account-transactions'))).toContain('business_unit_id=business-a'));
  fireEvent.click(await screen.findByRole('button', {name:'Evidence'}));
  await screen.findByText('No journal entries found for this period');
  await waitFor(() => expect(String(request('/evidence/'))).toContain('business_unit_id=business-a'));
});
