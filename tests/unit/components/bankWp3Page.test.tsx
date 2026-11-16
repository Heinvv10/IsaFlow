/**
 * WP3 at page level (real hooks and list frame; the children capture their props): the selection is cut to the rows on
 * screen whenever the list changes, "N selected" is always shown, an account switch clears EVERY filter and the
 * selection, "N filters active - Clear" names what narrows the list (and so does the empty state), and the AI poll
 * reloads silently (no skeleton) and with the latest loader.
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
  cap.poll = null;
});
afterEach(cleanup);

async function loaded() {
  render(<BankTransactionsPage />);
  await screen.findByTestId('bank-tx-selection-bar');
  await waitFor(() => expect((cap.table.transactions as unknown[] | undefined)?.length).toBe(3));
}

describe('selection', () => {
  it('"N selected" is always shown, starting at 0, and follows a tick', async () => {
    await loaded();
    expect(bar()).toBe('0 selected');
    await call(cap.table, 'onToggleSelect', 'p1a'); await call(cap.table, 'onToggleSelect', 'p1b');
    expect(bar()).toBe('2 selected');
    expect(selectedProp()).toEqual(['p1a', 'p1b']);
  });

  it('a page change prunes the selection: the bar reads 0 and the table is told nothing is selected', async () => {
    await loaded();
    await call(cap.table, 'onToggleSelect', 'p1a');
    expect(bar()).toBe('1 selected');
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect((cap.table.transactions as { id: string }[])[0]!.id).toBe('p2a'));
    expect(bar()).toBe('0 selected');
    expect(selectedProp()).toEqual([]);
    expect(cap.filters.selectedCount).toBe(0); // the bulk buttons' count too
  });

  it('a row that survives the reload stays selected; one that is gone is dropped', async () => {
    await loaded();
    await call(cap.table, 'onToggleSelect', 'p1a'); await call(cap.table, 'onToggleSelect', 'p1b');
    list = () => ok({ transactions: [row('p1b'), row('p1c')], total: 2 }); // p1a was accepted elsewhere
    await call(cap.filters, 'onRefresh');
    await waitFor(() => expect((cap.table.transactions as unknown[]).length).toBe(2));
    expect(selectedProp()).toEqual(['p1b']);
    expect(bar()).toBe('1 selected');
  });

  it('a search or filter change prunes it too', async () => {
    await loaded();
    await call(cap.table, 'onToggleSelect', 'p1a');
    list = () => ok({ transactions: [row('p1c')], total: 1 });
    await call(cap.filters, 'onAllocationFilterChange', 'suggested');
    await waitFor(() => expect((cap.table.transactions as unknown[]).length).toBe(1));
    expect(bar()).toBe('0 selected');
  });

  it('Clear selection empties it', async () => {
    await loaded();
    await call(cap.table, 'onToggleSelect', 'p1a');
    fireEvent.click(screen.getByTestId('bank-tx-selection-clear'));
    expect(bar()).toBe('0 selected');
  });
});

describe('filters', () => {
  it('"N filters active - Clear" appears when the list is narrowed and Clear removes every filter', async () => {
    await loaded();
    expect(screen.queryByTestId('active-filters')).toBeNull();
    await call(cap.filters, 'onFromDateChange', '2026-01-01');
    await call(cap.filters, 'onFromAmountChange', '100');
    await call(cap.filters, 'onTxTypeChange', 'spent');
    expect(screen.getByTestId('active-filters').textContent).toContain('3 filters active');
    await waitFor(() => expect(lastParams().get('from_date')).toBe('2026-01-01'));
    fireEvent.click(screen.getByTestId('active-filters-clear'));
    await waitFor(() => expect(lastParams().get('from_date')).toBeNull());
    expect(lastParams().get('from_amount')).toBeNull();
    expect(lastParams().get('tx_type')).toBeNull();
    expect(screen.queryByTestId('active-filters')).toBeNull();
  });

  it('an account switch clears the search, dates, amounts, sort and selects - and the selection', async () => {
    await loaded();
    await call(cap.filters, 'onFromDateChange', '2026-01-01');
    await call(cap.filters, 'onToAmountChange', '500');
    await call(cap.filters, 'onSortOrderChange', 'asc');
    await call(cap.filters, 'onAllocTypeChange', 'supplier');
    await call(cap.table, 'onToggleSelect', 'p1a');
    await waitFor(() => expect(lastParams().get('sort_order')).toBe('asc'));
    await call(cap.cards, 'onSelectBank', 'b');
    await waitFor(() => expect(lastParams().get('bank_account_id')).toBe('b'));
    await waitFor(() => { const q = lastParams(); expect([q.get('from_date'), q.get('to_amount'), q.get('sort_order'), q.get('alloc_type')]).toEqual([null, null, null, null]); });
    expect(cap.filters.fromDate).toBe('');
    expect(cap.filters.sortOrder).toBe('desc');
    expect(bar()).toBe('0 selected');
    expect(screen.queryByTestId('active-filters')).toBeNull();
  });

  it('the empty state names the filters that narrowed the list to nothing', async () => {
    await loaded();
    list = () => ok({ transactions: [], total: 0 });
    await call(cap.filters, 'onFromDateChange', '2026-03-01');
    await call(cap.filters, 'onTxTypeChange', 'received');
    expect((await screen.findByTestId('bank-tx-empty-filters')).textContent).toBe('From 2026-03-01, Type: received');
  });

  it('with no filter the empty state is the plain one', async () => {
    list = () => ok({ transactions: [], total: 0 });
    render(<BankTransactionsPage />);
    expect((await screen.findByTestId('bank-tx-empty')).textContent).toBe('No new transactions for this account');
    expect(screen.queryByTestId('bank-tx-empty-filters')).toBeNull();
  });
});

describe('the AI poll reloads silently', () => {
  it('a poll tick keeps the rows on screen: no skeleton while it loads; a Refresh does show one', async () => {
    await loaded();
    let release!: () => void;
    list = () => new Promise<Response>(resolve => { release = () => resolve(ok({ transactions: [row('p1a'), row('p1b'), row('late')], total: 60 })); });
    await act(async () => { void cap.poll!(); });
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
    expect((cap.table.transactions as unknown[]).length).toBe(3); // the old rows are still there
    await act(async () => { release(); });
    await waitFor(() => expect((cap.table.transactions as { id: string }[]).map(t => t.id)).toContain('late'));
    // a visible reload (Refresh) does blank to the skeleton
    list = () => new Promise<Response>(resolve => { release = () => resolve(ok({ transactions: [row('p1a')], total: 1 })); });
    await call(cap.filters, 'onRefresh');
    expect(await screen.findByTestId('list-skeleton')).toBeTruthy();
    await act(async () => { release(); });
  });

  it('a failing poll tick leaves the list alone (no error banner over good rows)', async () => {
    await loaded();
    list = () => new Response(JSON.stringify({ success: false, error: { message: 'down' } }), { status: 500 });
    await act(async () => { await cap.poll!(); });
    expect((cap.table.transactions as unknown[]).length).toBe(3);
    expect(screen.queryByText('down')).toBeNull();
  });
});
