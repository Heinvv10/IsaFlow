/**
 * WP4a at page level (3 of 3): switching account or tab is one list fetch; the same list reloading keeps its rows mounted
 * (announced, mouse-inert, `aria-busy`); a line that left the tab is off the screen before the reload answers; counts refresh
 * once per action; the page clamp rewrites history instead of pushing.
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
  await screen.findByTestId('bank-tx-selection-live');
  await waitFor(() => expect(ids().length).toBeGreaterThan(0));
  await settle();
}
const tabSelected = () => screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent;

describe('switching account or tab is ONE list fetch', () => {
  it('an account switch fetches once, with the new account and the default filters', async () => {
    await open();
    await call(cap.filters, 'onTxTypeChange', 'spent');
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(lastParams().get('offset')).toBe('25'));
    await settle();
    const n = listUrls().length;
    fireEvent.click(screen.getByTestId('card-b'));
    await settle();
    expect(listUrls().length - n).toBe(1);
    expect(Object.fromEntries(lastParams())).toMatchObject({ bank_account_id: 'b', offset: '0' });
    expect(lastParams().has('tx_type')).toBe(false);
  });
  it('a tab switch fetches once, on page 1 with the selects reset', async () => {
    await open();
    await call(cap.filters, 'onAllocationFilterChange', 'suggested');
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(lastParams().get('offset')).toBe('25'));
    await settle();
    const n = listUrls().length;
    fireEvent.click(screen.getByTestId('bank-tx-tab-reviewed'));
    await settle();
    expect(listUrls().length - n).toBe(1);
    expect(Object.fromEntries(lastParams())).toMatchObject({ status: 'matched', offset: '0' });
    expect(lastParams().has('allocation_filter')).toBe(false);
  });
});

describe('the table stays mounted while the same list reloads', () => {
  const frame = () => screen.getByTestId('bank-tx-list-frame');
  it('a page change keeps the current rows on screen, marked busy, until the next page arrives', async () => {
    await open();
    let release!: () => void;
    list = () => new Promise<Response>(r => { release = () => r(ok({ transactions: [row('p2a')], total: 60 })); });
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(frame().getAttribute('aria-busy')).toBe('true'));
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
    expect(ids()).toEqual(['p1a', 'p1b', 'p1c']);
    await act(async () => { release(); });
    await waitFor(() => expect(ids()).toEqual(['p2a']));
    expect(frame().getAttribute('aria-busy')).toBeNull();
  });
  it('an account switch IS a skeleton: the rows on screen belong to the other account', async () => {
    await open();
    list = () => new Promise<Response>(() => undefined);
    fireEvent.click(screen.getByTestId('card-b'));
    expect(await screen.findByTestId('list-skeleton')).toBeTruthy();
  });
  it('a failed reload of the same list still shows its error (the rows do not mask it)', async () => {
    await open();
    list = () => new Response(JSON.stringify({ success: false, error: { message: 'list is down' } }), { status: 500 });
    await call(cap.filters, 'onRefresh');
    expect(await screen.findByText(/list is down|Could not load transactions/)).toBeTruthy();
  });
});

describe('an accepted line is off the screen before the reload answers; counts are refreshed once', () => {
  it('accept: the row (and the count) go at once; the reload only tops up; one summary refresh', async () => {
    await open();
    await call(cap.table, 'onRowEntityChange', 'p1a', 'gl1', 'Telephone');
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    let releaseList!: () => void;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => {
      const url = String(u);
      if (url.includes('bank-transactions-action') && String((i as RequestInit | undefined)?.body).includes('"allocate"')) return ok({ journalEntryId: 'je1' });
      if (url.includes('/api/accounting/bank-transactions?')) return new Promise<Response>(r => { releaseList = () => r(ok({ transactions: [row('p1b'), row('p1c'), row('p1d')], total: 59 })); });
      return inner(u, i);
    });
    const summariesBefore = urls('bank-account-summaries').length;
    await act(async () => { void (cap.table.onAccept as (id: string) => Promise<boolean>)('p1a'); });
    await waitFor(() => expect(ids()).toEqual(['p1b', 'p1c'])); // gone, with the reload still pending
    expect(screen.getByTestId('bank-tx-list-frame').getAttribute('aria-busy')).toBe('true');
    await act(async () => { releaseList(); });
    await waitFor(() => expect(ids()).toEqual(['p1b', 'p1c', 'p1d']));
    await settle();
    expect(urls('bank-account-summaries').length - summariesBefore).toBe(1);
  });
});

describe('the page clamp REPLACES history (it never pushes)', () => {
  it('page 3, the list shrinks to 2 pages: the entry is rewritten to page 2, and Back reaches the entry before, not page 3 again', async () => {
    await open();
    // the list shrank: page 3 now has no rows and a total of 40 (2 pages)
    list = (url) => (params(url).get('offset') === '50' ? ok({ transactions: [], total: 40 }) : params(url).get('offset') === '25' ? ok({ transactions: [row('p2a')], total: 40 }) : PAGE1());
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    await waitFor(() => expect(cap.router!.query().page).toBe('2'));
    await settle();
    const clamp = cap.router!.calls.filter(c => c.query.page === '2');
    expect(clamp.map(c => c.kind)).toEqual(['replace']); // rewrote the page-3 entry in place
    expect(cap.router!.calls.filter(c => c.kind === 'push').map(c => c.query.page)).toEqual(['3']);
    await act(async () => { await cap.router!.back(); });
    await waitFor(() => expect(cap.router!.query().page).toBeUndefined());
    await settle();
    expect(cap.router!.query().page).toBeUndefined(); // stays on the earlier entry: no bounce back to page 2/3
    expect(lastParams().get('offset')).toBe('0');
  });
});

describe('clicking the account already open changes nothing', () => {
  it('the filters, the page and the selection survive, and nothing is fetched', async () => {
    await open();
    await call(cap.filters, 'onTxTypeChange', 'spent');
    await call(cap.table, 'onToggleSelect', 'p1a');
    await settle();
    const n = listUrls().length;
    fireEvent.click(screen.getByTestId('card-a')); // a is the selected account
    await settle();
    expect(cap.filters.txType).toBe('spent');
    expect(screen.getByTestId('bank-tx-selection-live').textContent).toBe('1 selected');
    expect(listUrls().length).toBe(n);
  });
});

describe('counts refresh once per action', () => {
  it('Refresh: one list fetch and one summary fetch', async () => {
    await open();
    await settle();
    const l = listUrls().length, sm = urls('bank-account-summaries').length;
    await call(cap.filters, 'onRefresh');
    await settle();
    expect(listUrls().length - l).toBe(1);
    expect(urls('bank-account-summaries').length - sm).toBe(1);
  });
  it('a bulk Delete: the lines go at once, then one list fetch and one summary fetch', async () => {
    vi.stubGlobal('confirm', () => true);
    await open();
    await call(cap.table, 'onToggleSelect', 'p1a'); await call(cap.table, 'onToggleSelect', 'p1b');
    await settle();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => (String(u).includes('bank-transactions-action') ? ok({ deleted: 2 }) : inner(u, i)));
    list = () => ok({ transactions: [row('p1c')], total: 58 });
    const l = listUrls().length, sm = urls('bank-account-summaries').length;
    await act(async () => { await (cap.filters.onBatchDelete as () => Promise<void>)(); });
    await settle();
    expect(ids()).toEqual(['p1c']);
    expect(listUrls().length - l).toBe(1);
    expect(urls('bank-account-summaries').length - sm).toBe(1);
  });
});

describe('a reload of the same list is announced and takes no mouse input', () => {
  const frame = () => screen.getByTestId('bank-tx-list-frame');
  it('"Updating…" is in a polite status region while it reloads, empty otherwise; the rows are pointer-inert; both clear when it ends', async () => {
    await open();
    const status = screen.getByTestId('bank-tx-updating');
    expect(status.getAttribute('role')).toBe('status'); expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    expect(frame().className).not.toMatch(/pointer-events-none/);
    let release!: () => void;
    list = () => new Promise<Response>(r => { release = () => r(ok({ transactions: [row('p2a')], total: 60 })); });
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(screen.getByTestId('bank-tx-updating').textContent).toBe('Updating…'));
    expect(frame().className).toMatch(/pointer-events-none/);
    expect(frame().getAttribute('aria-busy')).toBe('true');
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId('bank-tx-updating').textContent).toBe(''));
    expect(frame().className).not.toMatch(/pointer-events-none/); expect(frame().getAttribute('aria-busy')).toBeNull();
  });
  it('a first load is a skeleton, not "Updating…" over rows that are not there', async () => {
    cap.router = makeFakeRouter({});
    list = () => new Promise<Response>(() => undefined);
    render(<BankTransactionsPage />);
    expect(await screen.findByTestId('list-skeleton')).toBeTruthy();
    expect(screen.getByTestId('bank-tx-updating').textContent).toBe('');
  });
});

