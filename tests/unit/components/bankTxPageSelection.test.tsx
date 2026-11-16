/**
 * The page shell's wiring (WP1 PR-C round 2), with the real hooks and list frame and the children mocked to capture
 * their props: the default selection is the first ACTIVE account and falls back when the selected one disappears;
 * inactive accounts are never transfer targets; "n shown" is only said for a loaded, filtered New tab; a failed later
 * summary load shows the "out of date" note; and the list holds its skeleton (never "No new transactions") while the
 * accounts are still loading, including on Retry after a failed first load.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { summaryAcct } from '../helpers/bankSummaryFixture';

const cap = vi.hoisted(() => ({
  shownHistory: [] as unknown[], query: {} as Record<string, string>, isReady: true, cards: {} as Record<string, unknown>, filters: {} as Record<string, unknown>, modals: {} as Record<string, unknown>,
}));

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: cap.isReady, query: cap.query, pathname: '/', push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/bank-transactions/useBankTxRefData', () => ({ useBankTxRefData: () => undefined }));
vi.mock('@/components/accounting/BankTxTable', () => ({ BankTxTable: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxBatchPanel', () => ({ BankTxBatchPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxSuppliersNotice', () => ({ BankTxSuppliersNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/CodingMetricsStrip', () => ({ CodingMetricsStrip: () => null }));
vi.mock('@/components/accounting/bank-transactions/AutoPostRunsPanel', () => ({ AutoPostRunsPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/transferLinks', () => ({ useRelinkTransfersWithTick: () => [false, 0], TransferLinkNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/useBankTxActions', () => ({ buildBankTxActions: () => ({}) }));
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => <p>No bank accounts configured</p> }));
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({ BankTxBankCards: (p: Record<string, unknown>) => { cap.cards = p; cap.shownHistory.push(p.shown); return null; } }));
vi.mock('@/components/accounting/bank-transactions/BankTxFilters', () => ({ BankTxFilters: (p: Record<string, unknown>) => { cap.filters = p; return null; } }));
vi.mock('@/components/accounting/bank-transactions/BankTxModals', () => ({ BankTxModals: (p: Record<string, unknown>) => { cap.modals = p; return null; } }));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const boom = () => new Response(JSON.stringify({ success: false, error: { message: 'down' } }), { status: 500 });
const accts = (...a: ReturnType<typeof summaryAcct>[]) => ok({ asAt: '2026-11-16', accounts: a });
const listUrls = () => vi.mocked(apiFetch).mock.calls.map(c => String(c[0])).filter(u => u.includes('/api/accounting/bank-transactions?'));
const lastListBank = () => new URL(listUrls().at(-1)!, 'http://x').searchParams.get('bank_account_id');
const call = (obj: Record<string, unknown>, name: string, ...args: unknown[]) => act(async () => { (obj[name] as (...a: unknown[]) => unknown)(...args); });

let summaries: Array<() => Response | Promise<Response>> = [];
let list: (url: string) => Response | Promise<Response> = () => ok({ transactions: [], total: 3 });
beforeEach(() => {
  cap.query = {};
  cap.isReady = true;
  summaries = [];
  list = () => ok({ transactions: [], total: 3 });
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (u) => {
    const url = String(u);
    if (url.includes('bank-account-summaries')) return (summaries.length > 1 ? summaries.shift()! : summaries[0]!)();
    if (url.includes('/api/accounting/bank-transactions?')) return list(url);
    return ok({});
  });
});
afterEach(() => { cleanup(); });

const A = () => summaryAcct('a', { isActive: false, ledgerCents: 100 });
const B = () => summaryAcct('b');
const C = () => summaryAcct('c');

describe('selection', () => {
  it('the default is the first ACTIVE account, not the first account', async () => {
    summaries = [() => accts(A(), B())];
    render(<BankTransactionsPage />);
    await waitFor(() => expect(lastListBank()).toBe('b'));
    expect(listUrls().some(u => u.includes('bank_account_id=a'))).toBe(false);
  });

  it('an inactive account is selectable but never a transfer target; neither is the selected one', async () => {
    summaries = [() => accts(A(), B(), C())];
    render(<BankTransactionsPage />);
    await waitFor(() => expect((cap.modals.bankAccounts as unknown[] | undefined)?.length).toBe(1));
    expect((cap.modals.bankAccounts as { id: string }[]).map(t => t.id)).toEqual(['c']);
    await call(cap.cards, 'onSelectBank', 'a');
    await waitFor(() => expect(lastListBank()).toBe('a'));
    expect((cap.modals.bankAccounts as { id: string }[]).map(t => t.id).sort()).toEqual(['b', 'c']);
  });

  it('a selected account that disappears from the summary falls back to the default', async () => {
    summaries = [() => accts(A(), B()), () => accts(B())];
    render(<BankTransactionsPage />);
    await waitFor(() => expect(lastListBank()).toBe('b'));
    await call(cap.cards, 'onSelectBank', 'a');
    await waitFor(() => expect(lastListBank()).toBe('a'));
    await call(cap.filters, 'onRefresh'); // the next summary no longer has 'a'
    await waitFor(() => expect(lastListBank()).toBe('b'));
  });
});

describe('deep link and all-inactive', () => {
  it('?account_id= selects that account once it is among the accounts, without a notice', async () => {
    cap.query = { account_id: 'c' };
    summaries = [() => accts(A(), B(), C())];
    render(<BankTransactionsPage />);
    await waitFor(() => expect(lastListBank()).toBe('c'));
    expect(screen.queryByText(/isn't available/)).toBeNull();
  });

  it('?account_id= naming an account that is not in the summary says so and names the one shown', async () => {
    cap.query = { account_id: 'ghost' };
    summaries = [() => accts(A(), B())];
    render(<BankTransactionsPage />);
    expect(await screen.findByText("That account isn't available; showing Account b.")).toBeTruthy();
    await waitFor(() => expect(lastListBank()).toBe('b'));
  });

  it('every account inactive: nothing is selected for the user, no list is fetched, and the page says why', async () => {
    summaries = [() => accts(A(), summaryAcct('d', { isActive: false }))];
    render(<BankTransactionsPage />);
    expect(await screen.findByTestId('bank-summary-none-active')).toBeTruthy();
    expect(screen.queryByTestId('bank-summary-retry')).toBeNull(); // nothing to retry
    // The list frame renders nothing at all: not "No new transactions for this account".
    expect(screen.queryByTestId('bank-tx-list-frame')).toBeNull();
    expect(screen.queryByTestId('bank-tx-empty')).toBeNull();
    await new Promise(r => setTimeout(r, 100));
    expect(listUrls()).toEqual([]);
    await call(cap.cards, 'onSelectBank', 'a'); // an inactive account is still selectable by choice
    await waitFor(() => expect(lastListBank()).toBe('a'));
    expect(screen.queryByTestId('bank-summary-none-active')).toBeNull();
    expect(await screen.findByTestId('bank-tx-list-frame')).toBeTruthy();
  });

  it('with an active account the notice is never rendered, not even for the first frame', async () => {
    summaries = [() => accts(A(), B())];
    const seen: boolean[] = [];
    const obs = new MutationObserver(() => seen.push(!!document.querySelector('[data-testid="bank-summary-none-active"]')));
    obs.observe(document.body, { childList: true, subtree: true });
    render(<BankTransactionsPage />);
    await waitFor(() => expect(lastListBank()).toBe('b'));
    obs.disconnect();
    expect(seen.includes(true)).toBe(false);
  });

  it('a link that arrives after the accounts (router not ready, then ready) is applied', async () => {
    cap.isReady = false;
    summaries = [() => accts(A(), B(), C())];
    const view = render(<BankTransactionsPage />);
    await waitFor(() => expect(lastListBank()).toBe('b'));
    cap.query = { account_id: 'c' };
    cap.isReady = true;
    view.rerender(<BankTransactionsPage />);
    await waitFor(() => expect(lastListBank()).toBe('c'));
  });

  it('a deep link is applied once: a later summary that lists it does not move the user', async () => {
    cap.query = { account_id: 'c' };
    summaries = [() => accts(A(), B()), () => accts(A(), B(), C())];
    render(<BankTransactionsPage />);
    expect(await screen.findByText("That account isn't available; showing Account b.")).toBeTruthy();
    await call(cap.filters, 'onRefresh'); // now 'c' is listed
    await waitFor(() => expect(summaries.length).toBe(1));
    await new Promise(r => setTimeout(r, 100));
    expect(lastListBank()).toBe('b');
  });

  it('a chosen account that leaves the summary says so and shows the default', async () => {
    summaries = [() => accts(A(), B()), () => accts(B())];
    render(<BankTransactionsPage />);
    await waitFor(() => expect(lastListBank()).toBe('b'));
    await call(cap.cards, 'onSelectBank', 'a');
    await waitFor(() => expect(lastListBank()).toBe('a'));
    await call(cap.filters, 'onRefresh');
    expect(await screen.findByText('Account a is no longer listed; showing Account b.')).toBeTruthy();
  });
});

describe('"n shown" on the Awaiting-review tile', () => {
  it('only once a filter narrows the New tab and the list has loaded; a failed list says nothing, not "0 shown"', async () => {
    summaries = [() => accts(B())];
    render(<BankTransactionsPage />);
    await waitFor(() => expect(cap.cards.shown).toBeNull());
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(0));
    await call(cap.filters, 'onFromDateChange', '2026-01-01');
    await waitFor(() => expect(cap.cards.shown).toBe(3));
    list = () => boom();
    await call(cap.filters, 'onToDateChange', '2026-01-31');
    expect(await screen.findByText('down')).toBeTruthy(); // the list frame shows the server's message
    expect(cap.cards.shown).toBeNull();
  });

  it('after switching account it stays hidden until the NEW account\'s list has loaded (no flash of the previous total)', async () => {
    summaries = [() => accts(B(), C())];
    render(<BankTransactionsPage />);
    await waitFor(() => expect(listUrls().length).toBeGreaterThan(0));
    await call(cap.filters, 'onFromDateChange', '2026-01-01');
    await waitFor(() => expect(cap.cards.shown).toBe(3));
    let release!: () => void;
    list = () => new Promise<Response>(resolve => { release = () => resolve(ok({ transactions: [], total: 9 })); });
    const mark = cap.shownHistory.length;
    await call(cap.cards, 'onSelectBank', 'c');
    await waitFor(() => expect(lastListBank()).toBe('c'));
    expect(cap.cards.shown).toBeNull(); // the account switch cleared the filter (WP3), so nothing is narrowed yet
    await call(cap.filters, 'onFromDateChange', '2026-02-01'); // narrow c's list again: its total is in flight
    expect(cap.cards.shown).toBeNull(); // c's list is in flight; b's 3 must not be shown against c
    await act(async () => { release(); });
    await waitFor(() => expect(cap.cards.shown).toBe(9));
    // Not even for one render: b's 3 was never handed to the card while c was selected.
    expect(cap.shownHistory.slice(mark)).not.toContain(3);
  });
});

describe('the summary failing', () => {
  it('a failed later load keeps the page and shows "Figures may be out of date"; Retry clears it', async () => {
    summaries = [() => accts(B()), () => boom(), () => accts(B())];
    render(<BankTransactionsPage />);
    await waitFor(() => expect(cap.cards.bankAccounts).toBeTruthy());
    expect(screen.queryByTestId('bank-summary-stale')).toBeNull();
    await call(cap.filters, 'onRefresh');
    expect((await screen.findByTestId('bank-summary-stale')).textContent).toContain('Figures may be out of date');
    await act(async () => { screen.getByTestId('bank-summary-retry').click(); });
    await waitFor(() => expect(screen.queryByTestId('bank-summary-stale')).toBeNull());
  });

  it('while the accounts load the list holds its skeleton, never "No new transactions"', async () => {
    summaries = [() => new Promise<Response>(() => undefined)];
    render(<BankTransactionsPage />);
    expect(await screen.findByTestId('list-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('bank-tx-empty')).toBeNull();
  });

  it('Retry after a failed first load shows the skeleton while it loads, not the empty list', async () => {
    summaries = [() => boom(), () => new Promise<Response>(() => undefined)];
    render(<BankTransactionsPage />);
    const retry = await screen.findByTestId('bank-summary-retry');
    await act(async () => { retry.click(); });
    expect(await screen.findByTestId('list-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('bank-tx-empty')).toBeNull();
  });
});
