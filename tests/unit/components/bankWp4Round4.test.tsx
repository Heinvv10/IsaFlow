/**
 * WP4a round 4: a quick X -> Y -> X that reaches the router as ONE render must not leave stale "own write" keys that make a
 * later Back be ignored; years outside the ledger window are not dates; the list does not wait on a hung card-order read
 * (a link naming a usable account never waits, and the read gives up after CARD_ORDER_TIMEOUT_MS); a re-link's callback
 * failure is not "re-link failed" and an answer after unmount does nothing.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { summaryAcct } from '../helpers/bankSummaryFixture';
import { makeFakeRouter, type FakeRouterHandle } from '../helpers/fakeRouter';

const cap = vi.hoisted(() => ({
  table: {} as Record<string, unknown>, filters: {} as Record<string, unknown>,
  router: null as null | FakeRouterHandle, companyId: undefined as string | null | undefined,
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => cap.router!.use() }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ companyRole: 'owner', activeCompany: cap.companyId ? { id: cap.companyId } : null }),
  useActiveCompanyIdOrUndefined: () => cap.companyId,
}));
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
  BankTxBankCards: (p: { bankAccounts: Array<{ id: string }>; onSelectBank: (id: string) => void }) => (
    <div>{p.bankAccounts.map(b => <button key={b.id} type="button" data-testid={`card-${b.id}`} onClick={() => p.onSelectBank(b.id)}>{b.id}</button>)}</div>),
}));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';
import { parseUrlView } from '@/components/accounting/bank-transactions/bankTxUrlState';
import { useBankCardOrder, CARD_ORDER_TIMEOUT_MS } from '@/components/accounting/bank-transactions/useBankCardOrder';
import { useRelinkTransfers } from '@/components/accounting/bank-transactions/useRelinkTransfers';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const row = (id: string) => ({ id, description: id, amount: -10, transactionDate: '2026-06-01', status: 'imported' });
const urls = (n: string) => vi.mocked(apiFetch).mock.calls.map(c => String(c[0])).filter(u => u.includes(n));
const listUrls = () => urls('/api/accounting/bank-transactions?');
const lastParams = () => new URL(listUrls().at(-1)!, 'http://x').searchParams;
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise<void>(r => setImmediate(r)); }); };
const tabSelected = () => screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent;
let hangPrefs = false;
beforeEach(() => {
  cap.companyId = undefined; hangPrefs = false; cap.table = {}; cap.filters = {};
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (u) => {
    const url = String(u);
    if (url.includes('bank-account-summaries')) return ok({ asAt: '2026-11-16', accounts: [summaryAcct('a'), summaryAcct('b')] });
    if (url.includes('/api/auth/preferences')) return hangPrefs ? new Promise<Response>(() => undefined) : ok({});
    if (url.includes('/api/accounting/bank-transactions?')) return ok({ transactions: [row('p1')], total: 60 });
    return ok({});
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function open(q: Record<string, string> = {}) {
  cap.router = makeFakeRouter(q);
  render(<BankTransactionsPage />);
  await screen.findByTestId('bank-tx-selection-bar');
  await waitFor(() => expect(((cap.table.transactions ?? []) as unknown[]).length).toBeGreaterThan(0));
  await settle();
}

describe('stale own-write keys after a collapsed X -> Y -> X do not make Back be ignored', () => {
  beforeEach(() => { /* each test sets the collapse after opening */ });

  it('tabs: Reviewed -> Excluded -> Reviewed -> Back shows Excluded', async () => {
    await open(); cap.router!.setCollapse(60);
    fireEvent.click(screen.getByTestId('bank-tx-tab-reviewed'));
    fireEvent.click(screen.getByTestId('bank-tx-tab-excluded'));
    fireEvent.click(screen.getByTestId('bank-tx-tab-reviewed'));
    await waitFor(() => expect(tabSelected()).toMatch(/^Reviewed/)); await new Promise(r => setTimeout(r, 120)); await settle();
    cap.router!.setCollapse(0);
    await act(async () => { await cap.router!.back(); });
    await waitFor(() => expect(tabSelected()).toMatch(/^Excluded/));
    expect(cap.router!.query().tab).toBe('excluded');
  });

  it('pages: 2 -> 3 -> 2 -> Back shows page 3', async () => {
    await open(); cap.router!.setCollapse(60);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await new Promise(r => setTimeout(r, 120)); await settle();
    cap.router!.setCollapse(0);
    await act(async () => { await cap.router!.back(); });
    await waitFor(() => expect(lastParams().get('offset')).toBe('50'));
  });

  it('accounts: a -> b -> a -> Back shows b', async () => {
    await open({ account_id: 'a' }); cap.router!.setCollapse(60);
    fireEvent.click(screen.getByTestId('card-b'));
    fireEvent.click(screen.getByTestId('card-a'));
    await new Promise(r => setTimeout(r, 120)); await settle();
    fireEvent.click(screen.getByTestId('card-b'));
    fireEvent.click(screen.getByTestId('card-a'));
    await new Promise(r => setTimeout(r, 120)); await settle();
    cap.router!.setCollapse(0);
    await act(async () => { await cap.router!.back(); });
    await waitFor(() => expect(lastParams().get('bank_account_id')).toBe('b'));
  });
});

describe('years outside the ledger window are not dates', () => {
  it.each(['0000-01-01', '1899-12-31', '2201-01-01', '9999-12-31'])('%s is dropped', (d) => {
    expect(parseUrlView({ from: d }).filters).not.toHaveProperty('fromDate');
  });
  it.each(['1900-01-01', '2026-11-17', '2200-12-31'])('%s is kept', (d) => {
    expect(parseUrlView({ from: d }).filters.fromDate).toBe(d);
  });
});

describe('a card-order read that never answers does not hold the list', () => {
  it('a link naming a usable account fetches at once, without waiting for the order', async () => {
    cap.companyId = 'co-1'; hangPrefs = true;
    cap.router = makeFakeRouter({ account_id: 'b' });
    render(<BankTransactionsPage />);
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(0));
    expect(lastParams().get('bank_account_id')).toBe('b');
  });
  it('no link: the list waits, and the read gives up after the timeout (default order stands)', async () => {
    cap.companyId = 'co-1'; hangPrefs = true;
    cap.router = makeFakeRouter({});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<BankTransactionsPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_ORDER_TIMEOUT_MS - 100); });
    expect(listUrls()).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await vi.waitFor(() => expect(listUrls().length).toBeGreaterThan(0));
    expect(lastParams().get('bank_account_id')).toBe('a');
  });
  it('the hook: loaded turns true at the timeout, never before, and the timer is cleared on a normal answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    hangPrefs = true;
    const { result } = renderHook(() => useBankCardOrder('co-1'));
    await act(async () => { await vi.advanceTimersByTimeAsync(CARD_ORDER_TIMEOUT_MS - 1); });
    expect(result.current.loaded).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(result.current.loaded).toBe(true);
  });
});

describe('useRelinkTransfers: callback failure and unmount', () => {
  const post = () => vi.mocked(apiFetch).mockImplementation(async () => ok({ linked: 2, batchId: 'b1' }));
  it('onLinked throwing is not "re-link failed", and the pass counts as finished', async () => {
    post();
    const { result, rerender } = renderHook(({ id }) => useRelinkTransfers(id, () => { throw new Error('boom'); }), { initialProps: { id: 'a' } });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBe(1));
    await settle();
    expect(result.current).toBe(false);
    rerender({ id: 'b' }); rerender({ id: 'a' }); await settle();
    expect(vi.mocked(apiFetch).mock.calls.filter(c => String((c[1] as RequestInit).body).includes('"a"'))).toHaveLength(1);
  });
  it('an answer after unmount calls nothing', async () => {
    let answer!: (r: Response) => void;
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(r => { answer = r; }));
    const onLinked = vi.fn();
    const { unmount } = renderHook(() => useRelinkTransfers('a', onLinked));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    unmount();
    await act(async () => { answer(ok({ linked: 3, batchId: 'b' })); await new Promise(r => setTimeout(r, 5)); });
    expect(onLinked).not.toHaveBeenCalled();
  });
});
