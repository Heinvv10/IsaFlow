/**
 * WP4a at page level (1 of 3): the view lives in the URL and round-trips - restored on load in ONE fetch, written on every
 * change (push for account/tab/page, replace for filters), Back/Forward re-apply it, a slow router and a lagging query are
 * handled, a link to an inactive account or with junk in it is tidied by REPLACING the entry. Real hooks, list frame, tabs,
 * pager and chip; the cards, filters bar and table are stand-ins that capture their props.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('the view is restored from the URL', () => {
  it('a URL naming account, tab, page and filters opens exactly that list, in ONE fetch (never first the defaults)', async () => {
    await open({ account_id: 'b', tab: 'reviewed', page: '2', q: 'rent', min: '100', type: 'spent', sort: 'asc' });
    expect(listUrls()).toHaveLength(1);
    const q = lastParams();
    expect(Object.fromEntries(q)).toMatchObject({ bank_account_id: 'b', status: 'matched', offset: '25', search: 'rent', from_amount: '100', tx_type: 'spent', sort_order: 'asc' });
    expect(tabSelected()).toMatch(/^Reviewed/);
    expect(screen.getByTestId('active-filters-names').textContent).toContain('Search "rent"');
    expect(cap.filters.searchTerm).toBe('rent');
  });

  it('invalid parts of a URL are ignored: the page opens on the defaults, not on an error', async () => {
    await open({ account_id: 'a', tab: 'nonsense', page: '-3', from: 'yesterday', min: '1e3', alloc: 'maybe' });
    const q = lastParams();
    expect(q.get('status')).toBe('imported'); expect(q.get('offset')).toBe('0');
    expect(q.has('from_date')).toBe(false); expect(q.has('from_amount')).toBe(false); expect(q.has('allocation_filter')).toBe(false);
    expect(tabSelected()).toMatch(/^New/);
  });

  it('a deep link naming only an account still selects it, and the URL keeps that account and any key that is not ours', async () => {
    await open({ account_id: 'b', utm_source: 'mail' });
    expect(lastParams().get('bank_account_id')).toBe('b');
    await waitFor(() => expect(cap.router!.query().account_id).toBe('b'));
    expect(cap.router!.query().utm_source).toBe('mail');
  });
});

describe('the view is written to the URL', () => {
  it('the first write replaces (no history entry for just opening the page)', async () => {
    await open();
    expect(cap.router!.calls[0]).toMatchObject({ kind: 'replace', query: { account_id: 'a' } });
  });

  it('a tab and a page push a history entry; choosing a filter only replaces the current one', async () => {
    await open();
    const before = cap.router!.calls.length;
    fireEvent.click(screen.getByTestId('bank-tx-tab-reviewed'));
    await waitFor(() => expect(cap.router!.query().tab).toBe('reviewed'));
    await call(cap.filters, 'onTxTypeChange', 'received');
    await waitFor(() => expect(cap.router!.query().type).toBe('received'));
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(cap.router!.query().page).toBe('2'));
    const made = cap.router!.calls.slice(before);
    expect(made.map(c => c.kind)).toEqual(['push', 'replace', 'push']);
    expect(cap.router!.query()).toMatchObject({ account_id: 'a', tab: 'reviewed', type: 'received', page: '2' });
  });

  it('a search is written once typing settles, and Clear removes every filter key', async () => {
    await open();
    await call(cap.filters, 'onSearchChange', 'rent');
    await waitFor(() => expect(cap.router!.query().q).toBe('rent'), { timeout: 3000 });
    await call(cap.filters, 'onFromAmountChange', '50');
    await waitFor(() => expect(cap.router!.query().min).toBe('50'));
    fireEvent.click(screen.getByTestId('active-filters-clear'));
    await waitFor(() => expect(cap.router!.query().q).toBeUndefined());
    expect(cap.router!.query().min).toBeUndefined();
    expect(cap.router!.query().account_id).toBe('a');
  });

  it('nothing is written before the account is known (a deep link must not be lost)', async () => {
    cap.router = makeFakeRouter({ account_id: 'b' });
    list = () => new Promise<Response>(() => undefined);
    let releaseSummary!: () => void;
    const gate = new Promise<void>(r => { releaseSummary = r; });
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => { if (String(u).includes('bank-account-summaries')) await gate; return inner(u, i); });
    render(<BankTransactionsPage />);
    await settle();
    expect(cap.router!.calls).toHaveLength(0);
    expect(cap.router!.query().account_id).toBe('b');
    releaseSummary(); await settle();
    expect(cap.router!.query().account_id).toBe('b');
  });
});

describe('refresh, Back and Forward', () => {
  it('REFRESH: a page opened on the URL the first one wrote shows the same view', async () => {
    await open();
    fireEvent.click(screen.getByTestId('bank-tx-tab-excluded'));
    await waitFor(() => expect(cap.router!.query().tab).toBe('excluded'));
    await call(cap.filters, 'onToDateChange', '2026-05-31');
    await waitFor(() => expect(cap.router!.query().to).toBe('2026-05-31'));
    const url = { ...cap.router!.query() } as Record<string, string>;
    cleanup();
    await open(url);
    expect(tabSelected()).toMatch(/^Excluded/);
    expect(cap.filters.toDate).toBe('2026-05-31');
    expect(lastParams().get('status')).toBe('excluded');
    expect(lastParams().get('to_date')).toBe('2026-05-31');
  });

  it('BACK returns to the previous tab with its own filters, and Forward returns again', async () => {
    await open();
    fireEvent.click(screen.getByTestId('bank-tx-tab-reviewed'));
    await waitFor(() => expect(cap.router!.query().tab).toBe('reviewed'));
    await call(cap.filters, 'onTxTypeChange', 'spent');
    await waitFor(() => expect(cap.router!.query().type).toBe('spent'));
    fireEvent.click(screen.getByTestId('bank-tx-tab-excluded'));
    await waitFor(() => expect(cap.router!.query().tab).toBe('excluded'));
    expect(cap.filters.txType).toBe('all'); // a tab change resets the selects

    await act(async () => { await cap.router!.back(); });
    await waitFor(() => expect(tabSelected()).toMatch(/^Reviewed/));
    await waitFor(() => expect(cap.filters.txType).toBe('spent'));
    expect(lastParams().get('status')).toBe('matched'); expect(lastParams().get('tx_type')).toBe('spent');

    await act(async () => { await cap.router!.back(); });
    await waitFor(() => expect(tabSelected()).toMatch(/^New/));
    expect(cap.filters.txType).toBe('all');

    await act(async () => { await cap.router!.forward(); });
    await waitFor(() => expect(tabSelected()).toMatch(/^Reviewed/));
  });

  it('BACK across an account switch re-selects the earlier account and its page, with one fetch per step', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(cap.router!.query().page).toBe('2'));
    fireEvent.click(screen.getByTestId('card-b'));
    await waitFor(() => expect(cap.router!.query().account_id).toBe('b'));
    expect(cap.router!.query().page).toBeUndefined();
    const before = listUrls().length;
    await act(async () => { await cap.router!.back(); });
    await waitFor(() => expect(lastParams().get('bank_account_id')).toBe('a'));
    await settle();
    expect(lastParams().get('offset')).toBe('25');
    expect(listUrls().length - before).toBe(1);
  });

  it('two quick changes while the first write is still landing: the first one coming back does not undo the second', async () => {
    await open();
    const n = listUrls().length;
    cap.router!.setLatency(40); // a slow router: both writes are in flight at once
    await call(cap.filters, 'onTxTypeChange', 'spent');
    await call(cap.filters, 'onAllocationFilterChange', 'suggested');
    await waitFor(() => expect(cap.router!.query().alloc).toBe('suggested'), { timeout: 3000 });
    await settle();
    expect(listUrls().length - n).toBe(2); // one fetch per change: the first write landing late did not bounce the view back and forth
    expect(cap.router!.query()).toMatchObject({ type: 'spent', alloc: 'suggested' });
    expect(cap.filters.txType).toBe('spent'); expect(cap.filters.allocationFilter).toBe('suggested');
    expect(lastParams().get('tx_type')).toBe('spent'); expect(lastParams().get('allocation_filter')).toBe('suggested');
  });

  it('our own writes coming back through the router are not mistaken for navigation (no loop, no extra fetch)', async () => {
    await open();
    const n = listUrls().length;
    await call(cap.filters, 'onTxTypeChange', 'received');
    await settle();
    expect(listUrls().length - n).toBe(1);
    expect(cap.router!.calls.filter(c => c.query.type === 'received')).toHaveLength(1);
  });
});

describe('an account in the URL that is not active', () => {
  it('is not selected: the default opens instead (with the notice that the link was not available)', async () => {
    accounts = [summaryAcct('a'), summaryAcct('x', { isActive: false }), summaryAcct('b')];
    await open({ account_id: 'x' });
    expect(lastParams().get('bank_account_id')).toBe('a');
    expect(listUrls().some(u => params(u).get('bank_account_id') === 'x')).toBe(false);
    await waitFor(() => expect(cap.router!.query().account_id).toBe('a'));
  });
  it('a navigation to a link naming an inactive account (Back, or a link clicked elsewhere) does not select it', async () => {
    accounts = [summaryAcct('a'), summaryAcct('x', { isActive: false })];
    await open();
    await act(async () => { await cap.router!.navigate({ account_id: 'x', tab: 'reviewed' }); });
    await settle();
    expect(listUrls().some(u => params(u).get('bank_account_id') === 'x')).toBe(false);
    expect(cap.router!.query().account_id).toBe('a'); // the URL is put right again
  });
});

describe('the URL carries no impossible dates or empty searches', () => {
  it('?from=2026-02-31 opens the page without a date filter (the API would answer 500 to it)', async () => {
    await open({ account_id: 'a', from: '2026-02-31', to: '2026-13-01' });
    expect(lastParams().has('from_date')).toBe(false); expect(lastParams().has('to_date')).toBe(false);
  });
  it('?q=%20%20 is no search; ?min=900&max=100 is the range 100 to 900', async () => {
    await open({ account_id: 'a', q: '  ', min: '900', max: '100' });
    expect(lastParams().has('search')).toBe(false);
    expect(lastParams().get('from_amount')).toBe('100'); expect(lastParams().get('to_amount')).toBe('900');
  });
});
