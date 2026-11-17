/**
 * WP3 round 2 (from the #1508 breaker's cases): at page level, with the real hooks,
 *  - a silent reload that supersedes a visible one must not leave the skeleton up;
 *  - an action that finishes AFTER the user changed page or account reloads the view they are on NOW (every
 *    post-mutation reload goes through the latest loader), not the one on screen at click time;
 *  - a batch un-ticks only its own lines: a tick made on another page meanwhile stays.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { summaryAcct } from '../helpers/bankSummaryFixture';

const cap = vi.hoisted(() => ({
  table: {} as Record<string, unknown>, filters: {} as Record<string, unknown>, cards: {} as Record<string, unknown>,
  poll: null as null | (() => Promise<void>),
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/bank-transactions/useBankTxRefData', () => ({ useBankTxRefData: () => undefined }));
vi.mock('@/components/accounting/BankTxTable', () => ({ BankTxTable: (p: Record<string, unknown>) => { cap.table = p; return null; } }));
vi.mock('@/components/accounting/bank-transactions/BankTxBatchPanel', () => ({ BankTxBatchPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxSuppliersNotice', () => ({ BankTxSuppliersNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/CodingMetricsStrip', () => ({ CodingMetricsStrip: () => null }));
vi.mock('@/components/accounting/bank-transactions/AutoPostRunsPanel', () => ({ AutoPostRunsPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/transferLinks', () => ({ useRelinkTransfersWithTick: () => [false, 0], TransferLinkNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxModals', () => ({ BankTxModals: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({ BankTxBankCards: (p: Record<string, unknown>) => { cap.cards = p; return null; } }));
vi.mock('@/components/accounting/bank-transactions/BankTxFilters', () => ({ BankTxFilters: (p: Record<string, unknown>) => { cap.filters = p; return null; } }));
vi.mock('@/components/accounting/bank-transactions/useLlmResultPoll', () => ({
  useLlmResultPoll: (_t: unknown, reload: () => Promise<void>) => { cap.poll = reload; return { aiPolling: 0, pollForLlmResults: vi.fn() }; },
}));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const row = (id: string) => ({ id, description: id, amount: -10, transactionDate: '2026-06-01', status: 'imported' });
const A = () => summaryAcct('a'), B = () => summaryAcct('b');
const listUrls = () => vi.mocked(apiFetch).mock.calls.map(c => String(c[0])).filter(u => u.includes('/api/accounting/bank-transactions?'));
const lastParams = () => new URL(listUrls().at(-1)!, 'http://x').searchParams;
const call = (obj: Record<string, unknown>, name: string, ...args: unknown[]) => act(async () => { (obj[name] as (...a: unknown[]) => unknown)(...args); });
const selectedProp = () => [...(cap.table.selectedIds as Set<string>)].sort();
const bar = () => screen.getByTestId('bank-tx-selected-count').textContent;

let list: (url: string) => Response | Promise<Response>;
beforeEach(() => {
  list = (url) => (new URL(url, 'http://x').searchParams.get('offset') === '25' ? ok({ transactions: [row('p2a'), row('p2b')], total: 60 }) : ok({ transactions: [row('p1a'), row('p1b'), row('p1c')], total: 60 }));
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (u) => {
    const url = String(u);
    if (url.includes('bank-account-summaries')) return ok({ asAt: '2026-11-16', accounts: [A(), B()] });
    if (url.includes('/api/accounting/bank-transactions?')) return list(url);
    return ok({});
  });
  cap.poll = null; cap.table = {}; cap.filters = {}; cap.cards = {}; // an earlier test's unmounted page must not satisfy this test's waits
});
afterEach(cleanup);

async function loaded() {
  render(<BankTransactionsPage />);
  await screen.findByTestId('bank-tx-selection-bar');
  await waitFor(() => expect((cap.table.transactions as unknown[] | undefined)?.length).toBe(3));
}


describe('post-mutation reloads and the skeleton', () => {
  it('silent reload superseding a visible reload does not leave the skeleton stuck', async () => {
    await loaded();
    const rel: Array<() => void> = [];
    list = () => new Promise<Response>(resolve => { rel.push(() => resolve(ok({ transactions: [row('p1a'), row('late')], total: 60 }))); });
    await call(cap.filters, 'onRefresh');
    expect(await screen.findByTestId('list-skeleton')).toBeTruthy();
    await act(async () => { void cap.poll!(); });
    await act(async () => { rel.forEach(r => r()); });
    await waitFor(() => expect(screen.queryByTestId('list-skeleton')).toBeNull());
  });

  /** A bulk Delete held open at the server, so the user can move before it finishes. */
  async function deleteInFlight() {
    vi.stubGlobal('confirm', () => true);
    await loaded();
    await call(cap.table, 'onToggleSelect', 'p1a');
    let release!: () => void;
    const prev = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => {
      if (String(u).includes('bank-transactions-action')) return new Promise<Response>(r => { release = () => r(ok({ deleted: 1 })); });
      return prev(u, i);
    });
    await act(async () => { void (cap.filters.onBatchDelete as () => void)(); });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    return () => act(async () => { release(); });
  }

  it('Delete in flight, user pages to 2, Delete finishes: the reload is page 2, not the old page', async () => {
    const finish = await deleteInFlight();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect((cap.table.transactions as { id: string }[])[0]!.id).toBe('p2a'));
    await finish();
    await waitFor(() => expect(lastParams().get('offset')).toBe('25'));
    expect((cap.table.transactions as { id: string }[])[0]!.id).toBe('p2a');
  });

  it('Delete in flight, user switches account, Delete finishes: the reload asks for the NEW account', async () => {
    const finish = await deleteInFlight();
    await call(cap.cards, 'onSelectBank', 'b');
    await waitFor(() => expect(lastParams().get('bank_account_id')).toBe('b'));
    await finish();
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(listUrls().map(u => new URL(u, 'http://x').searchParams.get('bank_account_id')).at(-1)).toBe('b');
    expect(lastParams().get('bank_account_id')).toBe('b');
  });

  it('a batch finishing does not un-tick a line the user ticked on another page meanwhile', async () => {
    const finish = await deleteInFlight(); // p1a was ticked on page 1 and is being deleted
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect((cap.table.transactions as { id: string }[])[0]!.id).toBe('p2a'));
    await call(cap.table, 'onToggleSelect', 'p2a'); // a NEW tick on page 2
    expect(bar()).toBe('1 selected');
    await finish();
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(bar()).toBe('1 selected');
    expect(selectedProp()).toEqual(['p2a']);
  });
});
