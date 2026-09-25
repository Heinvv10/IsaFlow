/**
 * A person's bank allocation dated in a filed VAT period claims its input VAT
 * late (s16(3)); the allocate action returns `lateClaim`, and the bank screen's
 * accept (single and batch) must say so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', () => ({ extractPattern: () => '' }));

import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';

const fetchMock = vi.mocked(apiFetch);
const lc = { claimDate: '2026-07-01', lockPeriod: { start: '2026-05-01', end: '2026-06-30' }, inputTax: 15 };
const sel = { type: 'account', entityId: 'acc-1', label: 'Stationery', vatCode: 'standard' };

function actions() {
  return buildBankTxActions({
    transactions: [{ id: 't1', status: 'imported', feedState: 'posted' }, { id: 't2', status: 'imported', feedState: 'posted' }],
    glAccounts: [], selectedBank: null,
    selectedIds: new Set(['t1', 't2']), rowSelections: { t1: sel, t2: sel }, batchType: 'account',
    excludingTxId: null, createEntityTxId: null,
    setSmartRunning: vi.fn(), setRowSelections: vi.fn(), setTransactions: vi.fn(),
    setSelectedIds: vi.fn(), setShowBatchEdit: vi.fn(), setRulePrompt: vi.fn(),
    setExcludingTxId: vi.fn(), loadTransactions: vi.fn(), refreshBankAccounts: vi.fn(),
  } as unknown as Parameters<typeof buildBankTxActions>[0]);
}
const allocated = (lateClaim?: unknown) =>
  ({ ok: true, json: async () => ({ success: true, data: { journalEntryId: 'je', ...(lateClaim ? { lateClaim } : {}) } }) }) as unknown as Response;

describe('bank screen — late claim notice', () => {
  beforeEach(() => { fetchMock.mockReset(); vi.mocked(notify.info).mockReset(); });

  it('accept: tells the person the VAT was claimed in a later period', async () => {
    fetchMock.mockResolvedValue(allocated(lc));
    await actions().handleAccept('t1');
    expect(notify.info).toHaveBeenCalledWith('VAT claimed in a later period', expect.stringContaining('R15.00'));
  });

  it('accept: nothing for an ordinary allocation', async () => {
    fetchMock.mockResolvedValue(allocated());
    await actions().handleAccept('t1');
    expect(notify.info).not.toHaveBeenCalled();
  });

  it('batch accept: one summary for the lines claimed late', async () => {
    fetchMock.mockResolvedValue(allocated(lc));
    await actions().handleBatchAccept();
    expect(notify.info).toHaveBeenCalledWith("2 documents' VAT claimed in a later period", expect.stringContaining('R30.00'));
  });
});
