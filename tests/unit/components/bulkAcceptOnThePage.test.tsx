/**
 * z30 regression, on the REAL bank-transactions page: after Confirm answers 200 the dialog stays on "Posted 3 lines" and the
 * page does not remount (the button's count is not read again, the page's mount requests are not repeated).
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('next/router', () => ({ useRouter: () => routerValue }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }), useActiveCompanyIdOrUndefined: () => undefined }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/bank-transactions/useBankTxRefData', () => ({ useBankTxRefData: () => undefined }));
vi.mock('@/components/accounting/bank-transactions/useBankTxSummary', async () => {
  const { summaryAcct } = await import('../helpers/bankSummaryFixture');
  const state = { accounts: [summaryAcct('b1', { accountCode: '1100', accountName: 'Bank' })], status: 'ready', error: '', stale: false, refresh: async () => undefined, refreshSoon: () => undefined };
  return { useBankTxSummary: () => state };
});
vi.mock('@/components/accounting/bank-transactions/useBankTxActions', () => ({ buildBankTxActions: () => ({}) }));
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({ BankTxBankCards: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxFilters', () => ({ BankTxFilters: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxBatchPanel', () => ({ BankTxBatchPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxSuppliersNotice', () => ({ BankTxSuppliersNotice: () => null }));
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => null }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';

const routerValue = { query: { account_id: 'b1' }, pathname: '/accounting/bank-transactions', asPath: '/accounting/bank-transactions?account_id=b1', push: vi.fn(), replace: vi.fn(), isReady: true, events: { on: vi.fn(), off: vi.fn() } };
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const line = (n: number) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, date: '2026-11-17', description: `GP-BULK zq ${n}`, amount: -110 * n, glAccountId: 'gl-1', glAccountCode: '6100', glAccountName: 'Fuel', vatCode: 'none', confidence: 0.95, strategy: 'rule', version: 'v', effectiveVatCode: 'none', netAmount: 110 * n, vatAmount: 0, cc1Id: null, cc2Id: null, buId: null, cc1Code: null, cc2Code: null, buCode: null });
const PREVIEW = { bankAccountId: 'b1', minConfidence: 0.8, lines: [1, 2, 3].map(line), totalIn: 0, totalOut: 660, byAccount: [{ glAccountId: 'gl-1', code: '6100', name: 'Fuel', count: 3, totalIn: 0, totalOut: 660 }], truncated: false, totalEligibleAtLeast: 3, scanTruncated: false, nextScanAfter: null, needsAttention: [], needsAttentionCount: 0, excluded: { badTarget: 0, reconciliationHeld: 0, periodClosed: 0, noPeriod: 0, vatLocked: 0, vatCode: 0 }, previewToken: 'tok' };
const RESULT = { runId: 'run-1', posted: [1, 2, 3].map((n) => ({ txId: line(n).id, journalEntryId: `j${n}` })), refused: [], totalPosted: 660 };

const urls = () => vi.mocked(apiFetch).mock.calls.map(([u, i]) => `${i?.method ?? 'GET'} ${String(u)}`);
const count = (re: RegExp) => urls().filter((u) => re.test(u)).length;

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (u, init) => {
    const url = String(u);
    if (url.includes('/api/accounting/bank-bulk-accept')) return init?.method === 'POST' ? ok(RESULT) : ok(PREVIEW);
    if (url.includes('/api/accounting/bank-transactions?')) return ok({ transactions: [], total: 0 });
    return ok({});
  });
});
afterEach(cleanup);

describe('the real bank-transactions page with a bulk accept in progress', () => {
  it('after Confirm answers 200 the dialog shows "Posted 3 lines" and stays; the page does not remount', async () => {
    render(<BankTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 3 high-confidence suggestions/ }, { timeout: 4000 }));
    await screen.findByRole('dialog');
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 3/ }));
    expect((await screen.findByTestId('bulk-result')).textContent).toMatch(/Posted 3 lines/);

    const readsAtResult = count(/GET \/api\/accounting\/bank-bulk-accept/);
    const mountsAtResult = count(/bank-relink-transfers|bank-transfer-links|coding-metrics/);
    // Let everything the page may do on its own after a posted batch happen (timers, polls, effects).
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('bulk-result').textContent).toMatch(/Posted 3 lines/);
    expect(count(/GET \/api\/accounting\/bank-bulk-accept/)).toBe(readsAtResult); // no second mount of the button
    expect(count(/bank-relink-transfers|bank-transfer-links|coding-metrics/)).toBe(mountsAtResult); // no second mount of the page's panels
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo batch' })).toBeTruthy());
  });

  it('the page going away mid-confirm (a navigation) does not reload the page it left', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u, init) => {
      const url = String(u);
      if (url.includes('/api/accounting/bank-bulk-accept')) return init?.method === 'POST' ? new Promise<Response>(() => undefined) : ok(PREVIEW);
      if (url.includes('/api/accounting/bank-transactions?')) return ok({ transactions: [], total: 0 });
      return ok({});
    });
    const view = render(<BankTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 3 high-confidence suggestions/ }, { timeout: 4000 }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 3/ }));
    await screen.findByRole('button', { name: 'Posting…' });
    const listReads = count(/GET \/api\/accounting\/bank-transactions\?/);
    view.unmount();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(count(/GET \/api\/accounting\/bank-transactions\?/)).toBe(listReads);
  });

  it('under StrictMode (reactStrictMode is on) Done after a batch still reloads the page', async () => {
    render(<StrictMode><BankTransactionsPage /></StrictMode>);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 3 high-confidence suggestions/ }, { timeout: 4000 }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 3/ }));
    await screen.findByTestId('bulk-result');
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const listReads = count(/GET \/api\/accounting\/bank-transactions\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(count(/GET \/api\/accounting\/bank-transactions\?/)).toBeGreaterThan(listReads));
  });
});

