/**
 * The REAL handlers of useBankTxActions (only the network is mocked): every success path reloads the list AND the
 * bank-account summary, each exactly once. bankTxPageRefresh mocks buildBankTxActions, so without this a handler could
 * lose its refresh and the cards, tiles and statement panel would keep pre-mutation figures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';

const json = (data: unknown = {}) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

function setup() {
  const d = {
    transactions: [{ id: 't1', description: 'x', amount: -5, transactionDate: '2026-01-01', status: 'imported', feedState: 'posted' }],
    glAccounts: [], bankAccounts: [], selectedBank: 'b1', selectedIds: new Set(['t1']),
    rowSelections: { t1: { type: 'account' as const, entityId: 'gl1', label: 'Telephone' } },
    batchType: 'account' as const, excludingTxId: 't1', createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(),
    setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(), loadTransactions: vi.fn(), refreshBankAccounts: vi.fn(), reloadCurrentView: vi.fn(),
  };
  return { d, actions: buildBankTxActions(d as unknown as Parameters<typeof buildBankTxActions>[0]) };
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () => json({ accepted: 1, applied: 0, categorized: 0, skipped: 0, priorStatus: 'allocated', matchCount: 0 }));
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('window', Object.assign(globalThis.window ?? {}, { confirm: () => true }));
  vi.mocked(notify.error).mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

type Actions = ReturnType<typeof setup>['actions'];
const HANDLERS: Array<[string, (a: Actions) => Promise<unknown>]> = [
  ['accept (handleAccept)', a => a.handleAccept('t1')],
  ['exclude confirm (handleExcludeConfirm)', a => a.handleExcludeConfirm('duplicate')],
  ['unmatch (handleUnmatch)', a => a.handleUnmatch('t1')],
  ['batch accept (handleBatchAccept)', a => a.handleBatchAccept()],
  ['batch delete (handleBatchDelete)', a => a.handleBatchDelete()],
  ['bulk review (handleBulkAccept)', a => a.handleBulkAccept()],
  ['apply rules (handleApplyRules)', a => a.handleApplyRules()],
  ['reverse (handleReverse)', a => a.handleReverse('t1')],
];

describe('every success path reloads the list and the summary, once each', () => {
  for (const [name, run] of HANDLERS) {
    it(name, async () => {
      const { d, actions } = setup();
      await run(actions);
      expect(vi.mocked(notify.error).mock.calls, 'the handler succeeded').toEqual([]);
      expect(d.loadTransactions, `${name}: list reload`).toHaveBeenCalledTimes(1);
      expect(d.refreshBankAccounts, `${name}: summary refresh`).toHaveBeenCalledTimes(1);
    });
  }

  it('a refused action refreshes neither (nothing changed)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: false, error: { message: 'no' } }), { status: 400 }));
    const { d, actions } = setup();
    await actions.handleUnmatch('t1');
    await actions.handleReverse('t1');
    expect(d.refreshBankAccounts).not.toHaveBeenCalled();
  });
});
