/**
 * saveSelection (a row's account / supplier / customer choice) moves a line between Unallocated and Suggested, so a
 * SUCCESSFUL save refreshes the bank-account summary; a refused one does not, and says so (WP1 PR-C). The list is not
 * reloaded: the row on screen already shows the choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';

const deps = () => ({
  transactions: [], glAccounts: [], bankAccounts: [], selectedBank: 'b1', selectedIds: new Set<string>(), rowSelections: {},
  batchType: 'account' as const, excludingTxId: null, createEntityTxId: null,
  setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(), setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(),
  setRulePrompt: vi.fn(), setExcludingTxId: vi.fn(), loadTransactions: vi.fn(), refreshBankAccounts: vi.fn(), reloadCurrentView: vi.fn(),
});
beforeEach(() => { vi.mocked(apiFetch).mockReset(); toast.error.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('saveSelection', () => {
  it('a saved selection refreshes the summary and not the list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
    const d = deps();
    buildBankTxActions(d).saveSelection('t1', 'account', 'gl1');
    await vi.waitFor(() => expect(d.refreshBankAccounts).toHaveBeenCalledTimes(1));
    expect(d.loadTransactions).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a refused selection says so and does not refresh', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: false, error: { message: 'no' } }), { status: 400 }));
    const d = deps();
    buildBankTxActions(d).saveSelection('t1', 'account', 'gl1');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(d.refreshBankAccounts).not.toHaveBeenCalled();
  });
});
