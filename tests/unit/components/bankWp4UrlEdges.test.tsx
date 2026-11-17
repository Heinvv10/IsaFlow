/**
 * WP4a at page level (4 of 4): the edges of the URL sync. The URL is compared with what we last wrote, not with a router
 * query that lags a write (X -> Y -> X); a write the router never reports back cannot pile up; the drawer link dropping
 * `line` starts from the view's pending write, not from a stale query; React StrictMode's double effects do not undo a
 * restore; an unready router fetches nothing; a junk link is tidied by REPLACING its entry.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { summaryAcct } from '../helpers/bankSummaryFixture';
import { makeFakeRouter, type FakeRouterHandle } from '../helpers/fakeRouter';

const cap = vi.hoisted(() => ({
  table: {} as Record<string, unknown>, filters: {} as Record<string, unknown>, cards: {} as Record<string, unknown>,
  router: null as null | FakeRouterHandle, companyId: undefined as string | null | undefined,
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => cap.router!.use() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }), useActiveCompanyIdOrUndefined: () => cap.companyId }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/bank-transactions/useBankTxRefData', () => ({ useBankTxRefData: () => undefined }));
vi.mock('@/components/accounting/BankTxTable', () => ({ BankTxTable: (p: Record<string, unknown>) => { cap.table = p; return null; } }));
vi.mock('@/components/accounting/bank-transactions/BankTxBatchPanel', () => ({ BankTxBatchPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxSuppliersNotice', () => ({ BankTxSuppliersNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/CodingMetricsStrip', () => ({ CodingMetricsStrip: () => null }));
vi.mock('@/components/accounting/bank-transactions/AutoPostRunsPanel', () => ({ AutoPostRunsPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/transferLinks', () => ({ useRelinkTransfersWithTick: () => [false, 0], TransferLinkNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxModals', () => ({ BankTxModals: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxFilters', () => ({ BankTxFilters: (p: Record<string, unknown>) => { cap.filters = p; return null; } }));
vi.mock('@/components/accounting/bank-transactions/useLlmResultPoll', () => ({ useLlmResultPoll: () => ({ aiPolling: 0, pollForLlmResults: vi.fn() }) }));
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({
  BankTxBankCards: (p: { bankAccounts: Array<{ id: string; groupId?: string | null }>; onSelectBank: (id: string) => void } & Record<string, unknown>) => {
    cap.cards = p;
    return <div>{p.bankAccounts.map(b => (
      <button key={b.id} type="button" data-testid={`card-${b.id}`} data-card-key={b.groupId ? `group:${b.groupId}` : b.id} onClick={() => p.onSelectBank(b.id)}>{b.id}</button>
    ))}</div>;
  },
}));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const row = (id: string) => ({ id, description: id, amount: -10, transactionDate: '2026-06-01', status: 'imported' });
const A = () => summaryAcct('a'), B = () => summaryAcct('b');
const urls = (needle: string) => vi.mocked(apiFetch).mock.calls.map(c => String(c[0])).filter(u => u.includes(needle));
const listUrls = () => urls('/api/accounting/bank-transactions?');
const params = (u: string) => new URL(u, 'http://x').searchParams;
const lastParams = () => params(listUrls().at(-1)!);
const call = (obj: Record<string, unknown>, name: string, ...args: unknown[]) => act(async () => { (obj[name] as (...a: unknown[]) => unknown)(...args); });
const ids = () => ((cap.table.transactions ?? []) as { id: string }[]).map(t => t.id);
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise<void>(r => setImmediate(r)); }); };

let accounts: ReturnType<typeof A>[];
let prefs: Record<string, string>;
let list: (url: string) => Response | Promise<Response>;
const PAGE1 = () => ok({ transactions: [row('p1a'), row('p1b'), row('p1c')], total: 60 });
beforeEach(() => {
  accounts = [A(), B()]; prefs = {}; cap.companyId = undefined;
  list = () => PAGE1();
  cap.table = {}; cap.filters = {}; cap.cards = {};
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (u) => {
    const url = String(u);
    if (url.includes('bank-account-summaries')) return ok({ asAt: '2026-11-16', accounts });
    if (url.includes('/api/auth/preferences')) return ok(prefs);
    if (url.includes('/api/accounting/bank-transactions?')) return list(url);
    return ok({});
  });
});
afterEach(() => { cleanup(); });

async function open(query: Record<string, string> = {}) {
  cap.router = makeFakeRouter(query);
  render(<BankTransactionsPage />);
  await screen.findByTestId('bank-tx-selection-bar');
  await waitFor(() => expect(ids().length).toBeGreaterThan(0));
  await settle();
}
const tabSelected = () => screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent;

describe('the URL is compared with what we last wrote, not with the lagging router query', () => {
  it('X -> Y -> X before the router lands anything: the URL ends on X (the middle write does not leave it on Y)', async () => {
    await open();
    cap.router!.setLatency(40);
    await call(cap.filters, 'onTxTypeChange', 'spent');   // Y: written, still on its way
    await call(cap.filters, 'onTxTypeChange', 'all');     // back to X while router.query still shows the old URL
    await waitFor(() => expect(cap.router!.calls.length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    await new Promise(r => setTimeout(r, 200)); await settle();
    expect(cap.router!.query().type).toBeUndefined();
    expect(cap.filters.txType).toBe('all');
    expect(lastParams().has('tx_type')).toBe(false);
  });

  it('writes the router never reports back do not pile up: an old one is not mistaken for "our own" later', async () => {
    await open();
    cap.router!.setDropWrites(true);
    for (let i = 1; i <= 12; i++) await call(cap.filters, 'onFromAmountChange', String(i));   // 12 different writes, none lands
    const firstKey = cap.router!.calls.find(c => c.query.min === '1')!.query;
    cap.router!.setDropWrites(false);
    await act(async () => { await cap.router!.navigate({ ...firstKey } as Record<string, string>); }); // a real navigation to the URL of write #1
    await waitFor(() => expect(cap.filters.fromAmount).toBe('1'));
    expect(cap.router!.query().min).toBe('1');
  });
});

describe('the drawer link dropping `line` keeps a pending write of the view', () => {
  it('a filter chosen while the dropped-line replace is on its way is still there afterwards, in the URL and on screen', async () => {
    let failLine!: () => void;
    const gate = new Promise<void>(r => { failLine = r; });
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => {
      if (String(u).includes('bank-transaction-line')) { await gate; return new Response('{}', { status: 404 }); }
      return inner(u, i);
    });
    cap.router = makeFakeRouter({ account_id: 'a', line: 'gone-1' });
    cap.router.setLatency(40);
    render(<BankTransactionsPage />);
    await screen.findByTestId('bank-tx-selection-bar');
    await waitFor(() => expect(ids().length).toBeGreaterThan(0));
    await call(cap.filters, 'onTxTypeChange', 'spent');   // a write is on its way (the router is slow)...
    expect(cap.router.query().type).toBeUndefined();
    failLine();                                           // ...when the failed line fetch drops `line`
    await waitFor(() => expect(cap.router!.query().line).toBeUndefined(), { timeout: 3000 });
    await new Promise(r => setTimeout(r, 200)); await settle();
    expect(cap.router!.query().type).toBe('spent');
    expect(cap.filters.txType).toBe('spent');
  });
});

describe('React StrictMode', () => {
  it('its double effect run on mount does not undo a restore from the URL (tab, search and page survive)', async () => {
    cap.router = makeFakeRouter({ account_id: 'a', tab: 'reviewed', q: 'rent', page: '2', type: 'spent' });
    render(<StrictMode><BankTransactionsPage /></StrictMode>);
    await screen.findByTestId('bank-tx-selection-bar');
    await waitFor(() => expect(ids().length).toBeGreaterThan(0));
    await settle();
    expect(tabSelected()).toMatch(/^Reviewed/);
    expect(cap.filters.searchTerm).toBe('rent'); expect(cap.filters.txType).toBe('spent');
    expect(lastParams().get('offset')).toBe('25');
    expect(cap.router!.query()).toMatchObject({ tab: 'reviewed', q: 'rent', page: '2', type: 'spent' });
  });
});

describe('the router is not ready although the accounts have loaded', () => {
  it('nothing is fetched and nothing written until it is; then ONE fetch for the restored view', async () => {
    cap.router = makeFakeRouter({ account_id: 'b', tab: 'excluded', q: 'x' });
    cap.router.setReady(false);
    render(<BankTransactionsPage />);
    await waitFor(() => expect(urls('bank-account-summaries').length).toBeGreaterThan(0));
    await settle();
    expect(listUrls()).toHaveLength(0);
    expect(cap.router.calls).toHaveLength(0);
    expect(screen.getByTestId('list-skeleton')).toBeTruthy();
    act(() => { cap.router!.setReady(true); });
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(0));
    await settle();
    expect(listUrls()).toHaveLength(1);
    expect(Object.fromEntries(lastParams())).toMatchObject({ bank_account_id: 'b', status: 'excluded', search: 'x' });
  });
});

describe('Back to a URL that is not in canonical form', () => {
  it('is tidied by REPLACING that entry (never pushing a corrected one that leaves the junk one Back away)', async () => {
    await open();
    const before = cap.router!.calls.length;
    await act(async () => { await cap.router!.navigate({ account_id: 'a', tab: 'nonsense', page: '-4', min: '1e3' }); });
    await waitFor(() => expect(cap.router!.calls.length).toBeGreaterThan(before));
    await settle();
    const fix = cap.router!.calls.slice(before);
    expect(fix.map(c => c.kind)).toEqual(['replace']);
    expect(cap.router!.query()).toEqual({ account_id: 'a' });
    await act(async () => { await cap.router!.back(); });
    await settle();
    expect(cap.router!.query().tab).toBeUndefined(); // Back lands on the entry before the junk one, not on the junk
  });
  it('a link to an inactive account is corrected the same way', async () => {
    accounts = [summaryAcct('a'), summaryAcct('x', { isActive: false })];
    await open();
    const before = cap.router!.calls.length;
    await act(async () => { await cap.router!.navigate({ account_id: 'x' }); });
    await waitFor(() => expect(cap.router!.calls.length).toBeGreaterThan(before));
    await settle();
    expect(cap.router!.calls.slice(before).map(c => c.kind)).toEqual(['replace']);
    expect(cap.router!.query().account_id).toBe('a');
  });
});
