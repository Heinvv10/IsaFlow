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
  cards: {} as Record<string, unknown>, filters: {} as Record<string, unknown>, modals: {} as Record<string, unknown>,
}));

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', push: vi.fn(), replace: vi.fn() }) }));
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
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({ BankTxBankCards: (p: Record<string, unknown>) => { cap.cards = p; return null; } }));
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
