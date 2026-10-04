/**
 * D8 round 11 (census of the routes that reach a D8 flow): `undoAnyway` re-typed every failure of the undo it runs
 * as `HandCorrectionRefusedError` ("could not be reversed — for example, its period is closed"), a 400 — so a peer
 * holding a row of the bank reversal's flow budget read as a refusal the user should act on, not a retry. A lock
 * timeout now passes through as itself: 503 + Retry-After at the route.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) =>
    (/FROM bank_auto_post_runs/.test(strings.join('?')) ? [{ undone_at: null }] : [])),
  withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/bank/bankTxLock')>()),
  lockBankTransactionForUpdate: vi.fn(async () => ({ id: 'tx-1', auto_post_run_id: 'run-1' })),
}));
vi.mock('@/modules/accounting/services/bank/autoPostHandOffset', () => ({
  DECLARED_UNRELATED_REASON: 'declared', HAND_CORRECTION_REASON: 'hand',
  postingJournalOf: vi.fn(async () => 'je-posting'),
  offsetCandidate: vi.fn(async () => ({ id: 'je-blocker', entryNumber: 'JE-9', blocks: true })),
}));
const undoRow = vi.fn();
vi.mock('@/modules/accounting/services/bank/autoPostUndoService', () => ({ undoRow: (...a: unknown[]) => undoRow(...a) }));

import { HandCorrectionRefusedError, undoAnyway } from '@/modules/accounting/services/bank/autoPostHandCorrection';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';

describe('undoAnyway', () => {
  it('lets a lock timeout through as itself', async () => {
    const err = new RowLockTimeoutError('Bank transaction tx-1');
    undoRow.mockRejectedValueOnce(err);
    await expect(undoAnyway('co-1', 'run-1', 'tx-1', 'je-blocker', 'u-1')).rejects.toBe(err);
  });

  it('lets a raw 40P01 deadlock victim through as itself (D11 round 3), not as a refusal', async () => {
    const err = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    undoRow.mockRejectedValueOnce(err);
    await expect(undoAnyway('co-1', 'run-1', 'tx-1', 'je-blocker', 'u-1')).rejects.toBe(err);
  });

  it('still answers any other failure of the reversal as the refusal', async () => {
    undoRow.mockRejectedValueOnce(new Error('period closed'));
    await expect(undoAnyway('co-1', 'run-1', 'tx-1', 'je-blocker', 'u-1')).rejects.toBeInstanceOf(HandCorrectionRefusedError);
  });
});
