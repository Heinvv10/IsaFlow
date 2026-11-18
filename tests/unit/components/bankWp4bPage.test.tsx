/**
 * WP4b at page level: a status tile changes the view in ONE batch (the New tab with that status filter, one list fetch,
 * the filter in the URL); a second press drops it; the Excluded tile opens the Excluded tab. The page size (25 / 50 / 100)
 * is in the URL (`size`), drives the list's limit and offset, and survives an account switch. No floating "Mark Selected
 * as Reviewed" sits over the rows. Same stand-ins as bankWp4Page.test.tsx (cards, filters bar and table capture props).
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
import { log } from '@/lib/logger';
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

describe('status tiles drive the status filter', () => {
  it('from the Reviewed tab, Suggested opens New filtered to suggested: one fetch, the filter in the URL', async () => {
    await open({ account_id: 'a', tab: 'reviewed' });
    const before = listUrls().length;
    await call(cap.cards, 'onTile', 'suggested');
    await settle();
    expect(listUrls()).toHaveLength(before + 1);
    expect(Object.fromEntries(lastParams())).toMatchObject({ status: 'imported', allocation_filter: 'suggested', offset: '0' });
    expect(tabSelected()).toMatch(/^New/);
    expect(cap.cards.allocationFilter).toBe('suggested');
    await waitFor(() => expect(cap.router!.query().alloc).toBe('suggested'));
    expect(cap.router!.query().tab).toBeUndefined();
  });

  it('a second press drops the filter and stays on the tab', async () => {
    await open({ account_id: 'a', alloc: 'unallocated' });
    expect(lastParams().get('allocation_filter')).toBe('unallocated');
    await call(cap.cards, 'onTile', 'unallocated');
    await settle();
    expect(lastParams().has('allocation_filter')).toBe(false);
    expect(tabSelected()).toMatch(/^New/);
    await waitFor(() => expect(cap.router!.query().alloc).toBeUndefined());
  });

  it('the Excluded tile opens the Excluded tab, and again goes back to New', async () => {
    await open({ account_id: 'a' });
    await call(cap.cards, 'onTile', 'excluded');
    await settle();
    expect(tabSelected()).toMatch(/^Excluded/);
    expect(cap.cards.tab).toBe('excluded');
    await call(cap.cards, 'onTile', 'excluded');
    await settle();
    expect(tabSelected()).toMatch(/^New/);
  });
});

describe('a link pairing the status filter with another tab', () => {
  it('?tab=reviewed&alloc=allocated opens Reviewed WITHOUT the filter (nothing hidden narrows it), and the URL is tidied', async () => {
    await open({ account_id: 'a', tab: 'reviewed', alloc: 'allocated' });
    expect(listUrls()).toHaveLength(1);
    expect(lastParams().get('status')).toBe('matched');
    expect(lastParams().has('allocation_filter')).toBe(false);
    expect(cap.cards.allocationFilter).toBe('all');
    await waitFor(() => expect(cap.router!.query().alloc).toBeUndefined());
    expect(cap.router!.query().tab).toBe('reviewed');
  });
});

describe('rows per page', () => {
  it('?size=50&page=2 opens page 2 of 50 rows (60 lines: two pages), in one fetch', async () => {
    await open({ account_id: 'a', size: '50', page: '2' });
    expect(listUrls()).toHaveLength(1);
    expect(Object.fromEntries(lastParams())).toMatchObject({ limit: '50', offset: '50' });
    expect(cap.filters.pageSize).toBe(50);
  });

  it('choosing 50 in the footer: page 1 of 50, written to the URL, kept across an account switch', async () => {
    await open({ account_id: 'a', page: '2' });
    fireEvent.click(screen.getByRole('combobox', { name: 'Rows per page' }));
    fireEvent.click(screen.getByRole('option', { name: '50' }));
    await settle();
    expect(Object.fromEntries(lastParams())).toMatchObject({ limit: '50', offset: '0' });
    await waitFor(() => expect(cap.router!.query().size).toBe('50'));
    fireEvent.click(screen.getByTestId('card-b'));
    await settle();
    expect(Object.fromEntries(lastParams())).toMatchObject({ bank_account_id: 'b', limit: '50' });
  });
});

describe('the page size remembered in this browser', () => {
  it('a plain visit opens with the remembered size (and writes it to the URL); a size in the URL wins', async () => {
    localStorage.setItem('isaflow.bankTxPageSize', '50');
    try {
      await open({ account_id: 'a' });
      expect(lastParams().get('limit')).toBe('50');
      await waitFor(() => expect(cap.router!.query().size).toBe('50'));
      cleanup();
      vi.mocked(apiFetch).mockClear();
      await open({ account_id: 'a', size: '100' });
      expect(lastParams().get('limit')).toBe('100');
      cleanup();
      vi.mocked(apiFetch).mockClear();
      await open({ account_id: 'a', size: '25' }); // an explicit 25 beats the remembered 50, and stays in the URL
      expect(lastParams().get('limit')).toBe('25');
      await settle();
      expect(cap.router!.query().size).toBe('25');
    } finally { localStorage.removeItem('isaflow.bankTxPageSize'); }
  });
});

describe('nothing floats over the rows', () => {
  it('with rows on the New tab and one ticked, there is no floating "Mark Selected as Reviewed"', async () => {
    await open({ account_id: 'a' });
    await call(cap.table, 'onToggleSelect', 'p1a');
    expect(screen.getByTestId('bank-tx-selection-live').textContent).toBe('1 selected');
    expect(screen.queryByRole('button', { name: /Mark Selected as Reviewed/ })).toBeNull();
    expect(cap.filters.selectedCount).toBe(1);
  });
});

describe('a sort is not a filter in the empty state', () => {
  it('oldest first with an empty list: the empty state names no filter (the chip still lists the sort)', async () => {
    list = () => ok({ transactions: [], total: 0 });
    cap.router = makeFakeRouter({ account_id: 'a', sort: 'asc' });
    render(<BankTransactionsPage />);
    const empty = await screen.findByTestId('bank-tx-empty');
    await settle();
    expect(cap.filters.sortOrder).toBe('asc');
    expect(screen.getByText(/Sort: oldest first/)).toBeInTheDocument(); // the active-filters chip
    expect(screen.queryByTestId('bank-tx-empty-filters')).toBeNull();
    expect(empty).toHaveTextContent('No new transactions for this account');
  });
});

describe('a URL without a size, reached without a remount', () => {
  it('opens at the size just picked (a sidebar link, or Back to an entry with no size), not the one from page load', async () => {
    try {
      await open({ account_id: 'a' });
      expect(lastParams().get('limit')).toBe('25');
      fireEvent.click(screen.getByRole('combobox', { name: 'Rows per page' }));
      fireEvent.click(screen.getByRole('option', { name: '50' }));
      await settle();
      await waitFor(() => expect(cap.router!.query().size).toBe('50'));
      await act(async () => { await cap.router!.navigate({ account_id: 'a', tab: 'reviewed' }); }); // a link with no size
      await settle();
      expect(tabSelected()).toMatch(/^Reviewed/);
      expect(lastParams().get('limit')).toBe('50');
      expect(cap.filters.pageSize).toBe(50);
    } finally { localStorage.removeItem('isaflow.bankTxPageSize'); }
  });
});

describe('picking the default size over a remembered one, then a link with no size', () => {
  it('remembered 50, picked 25, then ?account_id=a&tab=reviewed: 25, and no spurious size=25 entry', async () => {
    localStorage.setItem('isaflow.bankTxPageSize', '50');
    try {
      await open({ account_id: 'a' });
      expect(lastParams().get('limit')).toBe('50');
      fireEvent.click(screen.getByRole('combobox', { name: 'Rows per page' }));
      fireEvent.click(screen.getByRole('option', { name: '25' }));
      await settle();
      await waitFor(() => expect(cap.router!.query().size).toBe('25')); // 25 differs from the base the page loaded with
      const before = cap.router!.calls.length;
      await act(async () => { await cap.router!.navigate({ account_id: 'a', tab: 'reviewed' }); });
      await settle();
      expect(tabSelected()).toMatch(/^Reviewed/);
      expect(lastParams().get('limit')).toBe('25');
      expect(cap.router!.calls.slice(before)).toEqual([]); // the link is already the canonical form: nothing written
      expect(cap.router!.query().size).toBeUndefined();
    } finally { localStorage.removeItem('isaflow.bankTxPageSize'); }
  });
});

describe('the remembered page size warns at most once per visit', () => {
  it('blocked storage warns once, not on every render', async () => {
    const getItem = window.localStorage.getItem.bind(window.localStorage);
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation((key: string) => {
      if (key === 'isaflow.bankTxPageSize') throw new DOMException('blocked', 'SecurityError');
      return getItem(key);
    });
    try {
      vi.mocked(log.warn).mockClear();
      await open({ account_id: 'a' });
      await call(cap.cards, 'onTile', 'suggested');
      await call(cap.table, 'onToggleSelect', 'p1a');
      await act(async () => { await cap.router!.navigate({ account_id: 'a', tab: 'reviewed' }); }); // each one re-reads it
      await act(async () => { await cap.router!.navigate({ account_id: 'a' }); });
      await settle();
      const unreadable = vi.mocked(log.warn).mock.calls.filter(c => c[0] === 'bank list: page size preference unreadable');
      expect(unreadable).toHaveLength(1);
      expect(lastParams().get('limit')).toBe('25'); // no preference: 25
    } finally { spy.mockRestore(); }
  });
});
