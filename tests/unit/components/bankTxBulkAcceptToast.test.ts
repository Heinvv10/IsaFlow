/**
 * K-111 review round 2 (LOW-7): the reviewed-count toast could not express a
 * partial result. bulkAcceptTransactions now returns the rows the status
 * predicate actually matched, so selecting 10 and moving 7 must not read as a
 * plain success — the operator has to be told 3 were skipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';

const success = vi.mocked(notify.success);
const warning = vi.mocked(notify.warning);
const fetchMock = vi.mocked(apiFetch);

import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';

function actionsFor(selected: string[]) {
  return buildBankTxActions({
    transactions: [], glAccounts: [], selectedBank: 'bank-1',
    selectedIds: new Set(selected), rowSelections: {}, batchType: 'account',
    excludingTxId: null, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(),
    setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(),
    setExcludingTxId: vi.fn(), loadTransactions: vi.fn(), refreshBankAccounts: vi.fn(),
  } as unknown as Parameters<typeof buildBankTxActions>[0]);
}

describe('bulk accept toast', () => {
  beforeEach(() => { success.mockReset(); warning.mockReset(); fetchMock.mockReset(); vi.mocked(notify.error).mockReset(); });

  it('warns, naming the skipped count, when fewer rows moved than were selected', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { accepted: 7 } }) } as unknown as Response);
    await actionsFor(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']).handleBulkAccept();
    expect(success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      '7 of 10 transaction(s) marked as reviewed',
      '3 were already reviewed or no longer eligible',
    );
  });

  it('reports a plain success when every selected row moved', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { accepted: 2 } }) } as unknown as Response);
    await actionsFor(['a', 'b']).handleBulkAccept();
    expect(warning).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('2 transaction(s) marked as reviewed');
  });

  it('surfaces the API refusal from the nested error envelope', async () => {
    // review round 3 LOW-5: apiResponse.error() nests at json.error.message, so
    // reading json.message alone reported a generic failure over the real reason.
    fetchMock.mockResolvedValue({
      ok: false, json: async () => ({ success: false, error: { message: 'Bank account is locked' } }),
    } as unknown as Response);
    await actionsFor(['a', 'b']).handleBulkAccept();
    expect(vi.mocked(notify.error)).toHaveBeenCalledWith('Bank account is locked');
  });

  it('warns when nothing moved at all', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { accepted: 0 } }) } as unknown as Response);
    await actionsFor(['a', 'b']).handleBulkAccept();
    expect(warning).toHaveBeenCalledWith(
      '0 of 2 transaction(s) marked as reviewed',
      '2 were already reviewed or no longer eligible',
    );
  });
});
