/**
 * Learning loop: marking an auto-posted line "corrected by hand" (R-079) re-codes its auto-posted decision;
 * a refused marking records nothing. The decision log is mocked to observe the call; the hand-correction
 * rules themselves are covered by the integration suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, recordHandCorrected, offsetCandidate } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  recordHandCorrected: vi.fn(async () => undefined),
  offsetCandidate: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/codingDecisionLog', () => ({ recordHandCorrected }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({
  lockBankTransactionForUpdate: vi.fn(async (_c: string, id: string) => ({ id, auto_post_run_id: 'run-1', status: 'allocated' })),
}));
vi.mock('@/modules/accounting/services/bank/autoPostHandOffset', () => ({
  DECLARED_UNRELATED_REASON: 'declared_unrelated',
  HAND_CORRECTION_REASON: 'hand_correction',
  postingJournalOf: vi.fn(async () => 'je-posting'),
  offsetCandidate,
}));
vi.mock('@/modules/accounting/services/bank/autoPostUndoService', () => ({ undoRow: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankReversalGate', () => ({ assertMayUndoRun: vi.fn(), auditRunUndo: vi.fn() }));

import { markCorrectedByHand } from '@/modules/accounting/services/bank/autoPostHandCorrection';

const okJournal = { id: 'je-hand', entryNumber: 'JE-9', netsPostingOut: true, byPerson: true, claimedElsewhere: false, declaredUnrelated: false };

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) =>
    (/FROM bank_auto_post_runs/.test(strings.join('?')) ? [{ undone_at: null }] : []));
});

describe('markCorrectedByHand -> decision log', () => {
  it('records the line\'s auto-posted decision as re-coded by the person', async () => {
    offsetCandidate.mockResolvedValue(okJournal);
    await markCorrectedByHand('co-1', 'run-1', 'tx-1', 'je-hand', 'u-1');
    // Keyed on the journal the auto-post put on the books.
    expect(recordHandCorrected).toHaveBeenCalledWith('co-1', 'tx-1', 'u-1', { journalEntryId: 'je-posting' });
  });

  it('a refused marking records nothing', async () => {
    offsetCandidate.mockResolvedValue({ ...okJournal, byPerson: false });
    await expect(markCorrectedByHand('co-1', 'run-1', 'tx-1', 'je-hand', 'u-1')).rejects.toThrow(/person posted/);
    expect(recordHandCorrected).not.toHaveBeenCalled();
  });
});
