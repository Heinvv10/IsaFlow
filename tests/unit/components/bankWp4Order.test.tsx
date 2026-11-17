/**
 * WP4a at page level (2 of 3): the default account is the first card in the user's order, read once (the page and the cards
 * share one source), nothing is fetched and nothing shown as empty until that order is known, and the selected card scrolls
 * into view once the order has applied.
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

describe('the default account and its card', () => {
  it('opens on the first card in THIS user\'s order, not the first the API lists', async () => {
    cap.companyId = 'co-1'; prefs = { 'bank_card_order:co-1': JSON.stringify(['b', 'a']) };
    await open();
    expect(listUrls().every(u => params(u).get('bank_account_id') === 'b')).toBe(true);
    expect(cap.router!.query().account_id).toBe('b');
  });
  it('...and picks nothing until that order is known: the list is never fetched for the wrong account first', async () => {
    cap.companyId = 'co-1'; prefs = { 'bank_card_order:co-1': JSON.stringify(['b', 'a']) };
    let releasePrefs!: () => void;
    const gate = new Promise<void>(r => { releasePrefs = r; });
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => { if (String(u).includes('/api/auth/preferences')) await gate; return inner(u, i); });
    cap.router = makeFakeRouter({});
    render(<BankTransactionsPage />);
    await waitFor(() => expect(urls('bank-account-summaries').length).toBeGreaterThan(0));
    await settle(); // the accounts are in, the order is not
    expect(listUrls()).toHaveLength(0);
    releasePrefs();
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(0));
    expect(listUrls().some(u => params(u).get('bank_account_id') === 'a')).toBe(false);
    expect(lastParams().get('bank_account_id')).toBe('b');
  });
  it('an order that cannot be read falls back to the API order', async () => {
    cap.companyId = 'co-1';
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => (String(u).includes('/api/auth/preferences') ? new Response('{}', { status: 500 }) : inner(u, i)));
    await open();
    expect(lastParams().get('bank_account_id')).toBe('a');
  });
  it('an explicit account in the URL wins over the user\'s order', async () => {
    cap.companyId = 'co-1'; prefs = { 'bank_card_order:co-1': JSON.stringify(['b', 'a']) };
    await open({ account_id: 'a' });
    expect(lastParams().get('bank_account_id')).toBe('a');
  });
  it('the selected card is scrolled into view when the selection changes (a sub-account scrolls its group card)', async () => {
    accounts = [A(), B(), summaryAcct('s1', { groupId: 'g1', groupName: 'Paycards' })];
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scroll(this: Element) { scrolled.push(this.getAttribute('data-card-key') ?? ''); };
    try {
      await open();
      expect(scrolled.at(-1)).toBe('a');
      fireEvent.click(screen.getByTestId('card-b'));
      await waitFor(() => expect(scrolled.at(-1)).toBe('b'));
      fireEvent.click(screen.getByTestId('card-s1'));
      await waitFor(() => expect(scrolled.at(-1)).toBe('group:g1'));
    } finally { Element.prototype.scrollIntoView = orig; }
  });
});

describe('while the saved order loads, the page is loading - not empty', () => {
  async function openWithSlowOrder() {
    cap.companyId = 'co-1'; prefs = { 'bank_card_order:co-1': JSON.stringify(['b', 'a']) };
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => { if (String(u).includes('/api/auth/preferences')) await gate; return inner(u, i); });
    cap.router = makeFakeRouter({});
    render(<BankTransactionsPage />);
    await waitFor(() => expect(urls('bank-account-summaries').length).toBeGreaterThan(0));
    await settle(); // the accounts are in, the order is not
    return release;
  }
  it('what is on screen is the skeleton: no "No new transactions", no empty state', async () => {
    const release = await openWithSlowOrder();
    expect(screen.getByTestId('list-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('bank-tx-empty')).toBeNull();
    expect(screen.queryByText(/No new transactions/)).toBeNull();
    release();
    await waitFor(() => expect(ids().length).toBeGreaterThan(0));
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
  });
  it('all accounts inactive is NOT loading: the "no active account" notice shows, not a skeleton forever', async () => {
    accounts = [summaryAcct('a', { isActive: false })];
    cap.router = makeFakeRouter({});
    render(<BankTransactionsPage />);
    expect(await screen.findByTestId('bank-summary-none-active')).toBeTruthy();
  });
  it('the preferences are read ONCE by the page (the cards, given the same source, add no second read)', async () => {
    cap.companyId = 'co-1'; prefs = { 'bank_card_order:co-1': JSON.stringify(['b', 'a']) };
    await open();
    expect(urls('/api/auth/preferences')).toHaveLength(1);
  });
  it('the selected card is scrolled to only once the order is known (not before: it would be scrolled to a spot the cards then leave)', async () => {
    cap.companyId = 'co-1'; prefs = { 'bank_card_order:co-1': JSON.stringify(['b', 'a']) };
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scroll(this: Element) { scrolled.push(this.getAttribute('data-card-key') ?? ''); };
    try {
      const release = await openWithSlowOrder();
      expect(scrolled).toEqual([]); // before the order is known: nothing selected, nothing scrolled
      release();
      await waitFor(() => expect(scrolled.at(-1)).toBe('b'));
      expect(scrolled.every(k => k === 'b')).toBe(true);
    } finally { Element.prototype.scrollIntoView = orig; }
  });
});

