import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import TrialBalancePage from '@/../pages/accounting/trial-balance';
import BalanceSheetPage from '@/../pages/accounting/reports/balance-sheet';
import AccountDetailPage from '@/../pages/accounting/reports/account-detail/[accountId]';
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({rowClass: ''}) }));
const route = vi.hoisted(() => ({query: {} as Record<string, string | string[]>, isReady: true, pathname: '', push: vi.fn()}));
vi.mock('next/router', () => ({useRouter: () => route}));
const cc = 'cf7d365f-0962-4fd8-be02-bb0cdef72c83';
const periods = [
  {id:'current', periodName:'Current', startDate:'2026-09-01', endDate:'2026-09-30', status:'open'},
  {id:'historic', periodName:'Historic', startDate:'2026-04-01', endDate:'2026-04-30', status:'closed'},
];
const account = {accountCode:'1110', accountName:'Bank', accountType:'asset', amount:17, balance:17, debitBalance:17, creditBalance:0};
const response = (data: unknown) => new Response(JSON.stringify({data}));
const params = (fragment: string) => vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes(fragment)).map(([url]) => new URL(String(url), 'http://localhost').searchParams);
function navigate(href: string) { route.query = Object.fromEntries(new URL(href, 'http://localhost').searchParams); }
afterEach(cleanup);
beforeEach(() => {
  route.query = {}; route.isReady = true;
  vi.mocked(apiFetch).mockReset().mockImplementation(async url => {
    const path = String(url);
    return response(path.includes('cost-centres') ? {items:[{id:cc, code:'CC2', name:'Project'}]}
      : path.includes('fiscal-periods?') ? {endDate:'2026-09-30'}
      : path.includes('fiscal-periods') ? periods
      : path.includes('reports-trial-balance') ? {rows:[account], balanced:false, totalDebit:17}
      : path.includes('reports-balance-sheet') ? {assets:[account], liabilities:[], equity:[], totalAssets:17, totalLiabilities:0, totalEquity:0}
      : path.includes('preferences') ? {reports_density:'owner'} : null);
  });
});

it('restores the actual TB link round trip including period, centre, comparison and movement', async () => {
  let view = render(<TrialBalancePage />);
  await screen.findByRole('link', {name:'Bank'});
  fireEvent.change(screen.getByDisplayValue('Current (open)'), {target:{value:'historic'}});
  fireEvent.change(screen.getByDisplayValue('No comparison'), {target:{value:'current'}});
  fireEvent.change(screen.getByDisplayValue('All Cost Centres'), {target:{value:cc}});
  fireEvent.click(screen.getByRole('button', {name:'Show movement'}));
  await waitFor(() => expect(params('reports-trial-balance').at(-1)?.get('cost_centre_id')).toBe(cc));
  navigate((await screen.findByRole('link', {name:'Bank'})).getAttribute('href')!);
  route.query.accountId = '1110'; view.unmount();
  view = render(<AccountDetailPage />);
  navigate(screen.getByRole('link', {name:'Back to Trial Balance'}).getAttribute('href')!);
  view.unmount(); render(<TrialBalancePage />);
  await screen.findByRole('link', {name:'Bank'});
  expect(screen.getByDisplayValue('CC2 — Project')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Historic (closed)')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Current')).toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Hide movement'})).toHaveAttribute('aria-pressed','true');
  expect(params('reports-trial-balance').at(-1)?.get('fiscal_period_id')).toBe('historic');
});

it('waits for router hydration before fetching restored TB state and responds to query changes', async () => {
  route.isReady = false;
  const view = render(<TrialBalancePage />);
  await screen.findByRole('option', {name:'CC2 — Project'});
  expect(params('reports-trial-balance')).toHaveLength(0);
  route.query = {fiscal_period_id:'historic', cost_centre_id:cc}; route.isReady = true;
  view.rerender(<TrialBalancePage />);
  await screen.findByRole('link', {name:'Bank'});
  expect(params('reports-trial-balance').every(p => p.get('cost_centre_id') === cc && p.get('fiscal_period_id') === 'historic')).toBe(true);
  route.query = {fiscal_period_id:'current'}; view.rerender(<TrialBalancePage />);
  await waitFor(() => expect(params('reports-trial-balance').at(-1)?.has('cost_centre_id')).toBe(false));
  expect(screen.getByDisplayValue('All Cost Centres')).toBeInTheDocument();
});

it('restores the actual BS link round trip with date, centre and comparator choices', async () => {
  route.query = {as_at_date:'2026-04-30'};
  let view = render(<BalanceSheetPage />);
  await screen.findByRole('link', {name:'Bank'});
  fireEvent.change(screen.getByDisplayValue('All Cost Centres'), {target:{value:cc}});
  fireEvent.click(screen.getByRole('checkbox', {name:'Prior period'}));
  await waitFor(() => expect(params('reports-balance-sheet').at(-1)?.get('compare_date')).toBe('2025-04-30'));
  navigate((await screen.findByRole('link', {name:'Bank'})).getAttribute('href')!);
  route.query.accountId = '1110'; view.unmount(); view = render(<AccountDetailPage />);
  navigate(screen.getByRole('link', {name:'Back to Balance Sheet'}).getAttribute('href')!);
  view.unmount(); render(<BalanceSheetPage />);
  await screen.findByRole('link', {name:'Bank'});
  expect(screen.getByDisplayValue('CC2 — Project')).toBeInTheDocument();
  expect(screen.getByDisplayValue('2026-04-30')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', {name:'Prior period'})).toBeChecked();
  expect(params('reports-balance-sheet').at(-1)?.get('compare_date')).toBe('2025-04-30');
});

it('retains centre and matches the fiscal period for older TB ledger URLs', async () => {
  route.query = {accountId:'1110', source:'tb', from:'2026-04-01', to:'2026-04-30', cost_centre_id:cc};
  const view = render(<AccountDetailPage />);
  navigate(screen.getByRole('link', {name:'Back to Trial Balance'}).getAttribute('href')!);
  view.unmount(); render(<TrialBalancePage />);
  await screen.findByRole('link', {name:'Bank'});
  expect(screen.getByDisplayValue('Historic (closed)')).toBeInTheDocument();
  expect(screen.getByDisplayValue('CC2 — Project')).toBeInTheDocument();
});

it('does not fetch default BS data during hydration and a late period response cannot overwrite the returned date', async () => {
  route.isReady = false;
  const view = render(<BalanceSheetPage />);
  await screen.findByRole('option', {name:'CC2 — Project'});
  expect(params('reports-balance-sheet')).toHaveLength(0);
  route.isReady = true;
  route.query = {as_at_date:'2026-04-30', cost_centre_id:cc, prior:'false', variance:'false', trend:'false'};
  view.rerender(<BalanceSheetPage />);
  await screen.findByRole('link', {name:'Bank'});
  expect(params('reports-balance-sheet').every(p => p.get('as_at_date') === '2026-04-30' && p.get('cost_centre_id') === cc && !p.has('compare_date'))).toBe(true);
  route.query = {as_at_date:'2026-03-31'}; view.rerender(<BalanceSheetPage />);
  await waitFor(() => expect(params('reports-balance-sheet').at(-1)?.get('as_at_date')).toBe('2026-03-31'));
  expect(params('reports-balance-sheet').at(-1)?.has('cost_centre_id')).toBe(false);
});

it('falls back to a valid fiscal period and ignores repeated controls', async () => {
  route.query = {fiscal_period_id:'missing', compare_period_id:'missing', cost_centre_id:[cc,cc], show_movement:['true','false']};
  render(<TrialBalancePage />);
  await screen.findByRole('link', {name:'Bank'});
  expect(screen.getByDisplayValue('Current (open)')).toBeInTheDocument();
  expect(screen.getByDisplayValue('No comparison')).toBeInTheDocument();
  expect(screen.getByDisplayValue('All Cost Centres')).toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Show movement'})).toHaveAttribute('aria-pressed','false');
});

it.each(['https://evil.example/accounting/trial-balance', '//evil.example/accounting/trial-balance', '/accounting/reports/balance-sheet', 'javascript:alert(1)'])('keeps account back navigation on its source report for %s', returnTo => {
  route.query = {source:'tb', return_to:returnTo, cost_centre_id:cc};
  render(<AccountDetailPage />);
  expect(screen.getByRole('link', {name:'Back to Trial Balance'})).toHaveAttribute('href', `/accounting/trial-balance?cost_centre_id=${cc}`);
});
