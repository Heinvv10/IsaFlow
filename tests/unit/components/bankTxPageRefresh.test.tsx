/**
 * Every path that writes must refresh the bank-account summary as well as the list, or the cards, tiles and statement
 * panel keep pre-mutation figures (WP1 PR-C, spec §4.2). The children are mocked so their callbacks can be captured
 * and fired; the summary fetches are counted at apiFetch. A summary-only path (saveSelection) adds a summary fetch and
 * no list fetch.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { summaryAcct } from '../helpers/bankSummaryFixture';

const cap = vi.hoisted(() => ({
  modals: {} as Record<string, () => void>,
  filters: {} as Record<string, () => void>,
  autoPostUndone: null as null | (() => void),
  transferChanged: null as null | (() => void),
  relinked: null as null | (() => void),
  poll: null as null | (() => Promise<void>),
  actionsDeps: {} as Record<string, () => void>,
  cards: {} as Record<string, () => void>,
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
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => <p>No bank accounts configured</p> }));
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({
  BankTxBankCards: (p: Record<string, () => void>) => { cap.cards = p; return null; },
}));
vi.mock('@/components/accounting/bank-transactions/BankTxFilters', () => ({
  BankTxFilters: (p: Record<string, () => void>) => { cap.filters = p; return null; },
}));
vi.mock('@/components/accounting/bank-transactions/BankTxModals', () => ({
  BankTxModals: (p: Record<string, () => void>) => { cap.modals = p; return null; },
}));
vi.mock('@/components/accounting/bank-transactions/AutoPostRunsPanel', () => ({
  AutoPostRunsPanel: ({ onUndone }: { onUndone: () => void }) => { cap.autoPostUndone = onUndone; return null; },
}));
vi.mock('@/components/accounting/bank-transactions/transferLinks', () => ({
  useRelinkTransfersWithTick: (_bank: string, onLinked: () => void) => { cap.relinked = onLinked; return [false, 0]; },
  TransferLinkNotice: ({ onChanged }: { onChanged: () => void }) => { cap.transferChanged = onChanged; return null; },
}));
vi.mock('@/components/accounting/bank-transactions/useLlmResultPoll', () => ({
  useLlmResultPoll: (_t: unknown, reload: () => Promise<void>) => { cap.poll = reload; return { aiPolling: 0, pollForLlmResults: vi.fn() }; },
}));
vi.mock('@/components/accounting/bank-transactions/useBankTxActions', () => ({
  buildBankTxActions: (deps: Record<string, () => void>) => { cap.actionsDeps = deps; return {}; },
}));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const urls = () => vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));
const summaryFetches = () => urls().filter(u => u.includes('/api/accounting/bank-account-summaries')).length;
const listFetches = () => urls().filter(u => u.includes('/api/accounting/bank-transactions?')).length;

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (u) => {
    const url = String(u);
    if (url.includes('bank-account-summaries')) return ok({ asAt: '2026-11-16', accounts: [summaryAcct('b1')] });
    if (url.includes('/api/accounting/bank-transactions?')) return ok({ transactions: [], total: 0 });
    return ok({});
  });
});
afterEach(() => { cleanup(); });

async function loaded() {
  render(<BankTransactionsPage />);
  await waitFor(() => expect(cap.modals.onSplitDone).toBeTypeOf('function'));
  await waitFor(() => { expect(summaryFetches()).toBe(1); expect(listFetches()).toBeGreaterThanOrEqual(1); });
}

async function fires(name: string, fire: () => unknown, { list = true }: { list?: boolean } = {}) {
  await loaded();
  const s0 = summaryFetches(), l0 = listFetches();
  await act(async () => { await fire(); });
  await waitFor(() => expect(summaryFetches(), `${name}: summary refetch`).toBe(s0 + 1));
  if (list) await waitFor(() => expect(listFetches(), `${name}: list refetch`).toBe(l0 + 1));
  else expect(listFetches(), `${name}: list untouched`).toBe(l0);
}

describe('the bank transactions page refreshes the summary on every mutating path', () => {
  it('Link done', () => fires('link', () => cap.modals.onLinkDone!()));
  it('Split done', () => fires('split', () => cap.modals.onSplitDone!()));
  it('Find-match done', () => fires('find-match', () => cap.modals.onFindMatchDone!()));
  it('Create-rule done', () => fires('create-rule', () => cap.modals.onCreateRuleDone!()));
  it('the Refresh button', () => fires('refresh', () => cap.filters.onRefresh!()));
  it('auto-post run undo / hand-offset decision', () => fires('auto-post undone', () => cap.autoPostUndone!()));
  it('transfer-link undo', () => fires('transfer changed', () => cap.transferChanged!()));
  it('the relink callback', () => fires('relink', () => cap.relinked!()));
  it('the AI-suggestion poll', () => fires('poll', () => cap.poll!()));
  it('an undo toast (reloadCurrentView)', () => fires('undo toast', () => cap.actionsDeps.reloadCurrentView!()));
  it('saveSelection success refreshes the summary only (the list is unchanged)', () =>
    fires('save selection', () => cap.actionsDeps.refreshBankAccounts!(), { list: false }));
  it('saveSelection is handed a DEBOUNCED summary refresh: a burst of row edits costs one fetch', async () => {
    await loaded();
    const s0 = summaryFetches(), l0 = listFetches();
    await act(async () => { for (let i = 0; i < 4; i++) cap.actionsDeps.refreshSummarySoon!(); });
    expect(summaryFetches()).toBe(s0); // nothing yet: inside the trailing window
    await waitFor(() => expect(summaryFetches()).toBe(s0 + 1), { timeout: 3000 });
    await new Promise(r => setTimeout(r, 700)); // a second fetch would have landed by now
    expect(summaryFetches()).toBe(s0 + 1);
    expect(listFetches()).toBe(l0);
  });
  it('the ungrouped-accounts hint, after a move, refreshes the summary only', () =>
    fires('ungrouped hint', () => cap.cards.onAccountsChanged!(), { list: false }));
});

describe('a failed bank-account summary', () => {
  it('is an error with Retry, never the "No bank accounts configured" empty state; Retry loads the page', async () => {
    let fail = true;
    vi.mocked(apiFetch).mockImplementation(async (u) => {
      const url = String(u);
      if (url.includes('bank-account-summaries')) {
        return fail ? new Response(JSON.stringify({ success: false, error: { message: 'db down' } }), { status: 500 })
          : ok({ asAt: '2026-11-16', accounts: [summaryAcct('b1')] });
      }
      return ok({ transactions: [], total: 0 });
    });
    render(<BankTransactionsPage />);
    expect(await screen.findByTestId('bank-summary-error')).toBeTruthy();
    expect(screen.queryByText('No bank accounts configured')).toBeNull();
    fail = false;
    await act(async () => { screen.getByTestId('bank-summary-retry').click(); });
    await waitFor(() => expect(screen.queryByTestId('bank-summary-error')).toBeNull());
    expect(screen.queryByText('No bank accounts configured')).toBeNull();
  });

  it('zero accounts after a SUCCESSFUL load is the empty state', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ asAt: '2026-11-16', accounts: [] }));
    render(<BankTransactionsPage />);
    expect(await screen.findByText('No bank accounts configured')).toBeTruthy();
  });
});

describe('the Provisional tab', () => {
  it('"incl. n provisional" asks the list for status=provisional', async () => {
    await loaded();
    await act(async () => { cap.cards.onShowProvisional!(); });
    await waitFor(() => expect(urls().some(u => u.includes('/api/accounting/bank-transactions?') && u.includes('status=provisional'))).toBe(true));
  });
});
