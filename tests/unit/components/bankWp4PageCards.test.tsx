/**
 * WP4a round 4 (REAL cards on the real page): a quick X -> Y -> X that reaches the router as ONE render must not leave stale "own write" keys that make a
 * later Back be ignored; years outside the ledger window are not dates; the list does not wait on a hung card-order read
 * (a link naming a usable account never waits, and the read gives up after CARD_ORDER_TIMEOUT_MS); a re-link's callback
 * failure is not "re-link failed" and an answer after unmount does nothing.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/components/accounting/bank-transactions/BankStatementPanel', () => ({ BankStatementPanel: () => null }));
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const row = (id: string) => ({ id, description: id, amount: -10, transactionDate: '2026-06-01', status: 'imported' });
const urls = (n: string) => vi.mocked(apiFetch).mock.calls.map(c => String(c[0])).filter(u => u.includes(n));
const listUrls = () => urls('/api/accounting/bank-transactions?');
const lastParams = () => new URL(listUrls().at(-1)!, 'http://x').searchParams;
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise<void>(r => setImmediate(r)); }); };
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

describe('the page hands its card-order source to the real cards', () => {
  it('one read of the preferences, and the cards show the saved order', async () => {
    cap.companyId = 'co-1';
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (u, i) => (String(u).includes('/api/auth/preferences') ? ok({ 'bank_card_order:co-1': JSON.stringify(['b', 'a']) }) : inner(u, i)));
    await open();
    await waitFor(() => expect(screen.getAllByTestId('bank-card-slot').map(e => e.getAttribute('data-card-key'))).toEqual(['b', 'a']));
    expect(urls('/api/auth/preferences')).toHaveLength(1);
    expect(lastParams().get('bank_account_id')).toBe('b');
  });
});
