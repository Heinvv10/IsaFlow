import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BalanceSheetPage from '@/../pages/accounting/reports/balance-sheet';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({rowClass: ''}) }));
vi.mock('@/components/accounting/BalanceSheetBody', () => ({
  BalanceSheetBody: ({report: value}: {report: {totalAssets:number}}) =>
    <div data-testid="total-assets">{value.totalAssets}</div>,
}));
const route = vi.hoisted(() => ({ query: {} as Record<string, string | string[]>, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));

const report = { assets: [], liabilities: [], equity: [], totalAssets: 0, totalLiabilities: 0, totalEquity: 0 };
const response = (data: unknown, status = 200) => new Response(JSON.stringify({data}), {status});
const reportParams = () => vi.mocked(apiFetch).mock.calls
  .filter(([url]) => String(url).includes('reports-balance-sheet'))
  .map(([url]) => new URL(String(url), 'http://localhost').searchParams);

beforeEach(() => {
  route.query = {};
  route.isReady = true;
  vi.mocked(apiFetch).mockReset().mockImplementation(async url => {
    const path = String(url);
    if (path.includes('business-units')) return response(null, 503);
    if (path.includes('cost-centres')) return response({items:[]});
    if (path.includes('fiscal-periods')) return response({endDate:'2026-04-30'});
    return response(report);
  });
});
afterEach(cleanup);

it('restores a late-hydrated BU and keeps an unavailable selection visible', async () => {
  route.isReady = false;
  const view = render(<BalanceSheetPage />);
  expect(reportParams()).toHaveLength(0);

  route.query = {as_at_date:'2026-04-30', business_unit_id:'20000000-0000-4000-8000-000000000001'};
  route.isReady = true;
  view.rerender(<BalanceSheetPage />);

  expect(await screen.findByDisplayValue('Selected Business Unit (unavailable)')).toBeInTheDocument();
  await waitFor(() => expect(reportParams().at(-1)?.get('business_unit_id'))
    .toBe('20000000-0000-4000-8000-000000000001'));
});

it('ignores an older unfiltered response that resolves after the BU report', async () => {
  let resolveUnfiltered!: (value: Response) => void;
  let resolveFiltered!: (value: Response) => void;
  const unfiltered = new Promise<Response>(resolve => { resolveUnfiltered = resolve; });
  const filtered = new Promise<Response>(resolve => { resolveFiltered = resolve; });
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = String(url);
    if (path.includes('business-units') || path.includes('cost-centres')) return response({items:[]});
    if (path.includes('fiscal-periods')) return response({endDate:'2026-04-30'});
    return new URL(path, 'http://localhost').searchParams.has('business_unit_id') ? filtered : unfiltered;
  });

  const view = render(<BalanceSheetPage />);
  await waitFor(() => expect(reportParams()).toHaveLength(1));
  route.query = {business_unit_id:'20000000-0000-4000-8000-000000000001'};
  view.rerender(<BalanceSheetPage />);
  await waitFor(() => expect(reportParams()).toHaveLength(2));

  await act(async () => resolveFiltered(response({...report, totalAssets:22})));
  expect(await screen.findByTestId('total-assets')).toHaveTextContent('22');
  await act(async () => resolveUnfiltered(response({...report, totalAssets:11})));
  expect(screen.getByTestId('total-assets')).toHaveTextContent('22');
});

it('clears a previous report when the selected BU request fails', async () => {
  vi.mocked(apiFetch).mockImplementation(async url => {
    const path = String(url);
    if (path.includes('business-units') || path.includes('cost-centres')) return response({items:[]});
    if (path.includes('fiscal-periods')) return response({endDate:'2026-04-30'});
    return new URL(path, 'http://localhost').searchParams.has('business_unit_id')
      ? response({message:'Bad business unit'}, 400) : response({...report, totalAssets:11});
  });
  const view = render(<BalanceSheetPage />);
  expect(await screen.findByTestId('total-assets')).toHaveTextContent('11');

  route.query = {business_unit_id:'malformed'};
  view.rerender(<BalanceSheetPage />);
  expect(await screen.findByText('Failed to load')).toBeInTheDocument();
  expect(screen.queryByTestId('total-assets')).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Export CSV'})).toBeDisabled();
  expect(screen.getByRole('button', {name:'Export Excel'})).toBeDisabled();
});
