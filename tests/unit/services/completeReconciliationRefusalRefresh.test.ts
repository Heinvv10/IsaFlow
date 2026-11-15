/**
 * A refused completion refreshes the stored header figure after the refusal. That refresh runs in its own savepoint,
 * and a refresh that throws must neither replace the refusal nor escape: an SQL error outside a savepoint would abort
 * the request transaction, and withAuth's COMMIT would silently roll the whole request back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const header = {
  id: 'rec-1', bank_account_id: 'b', statement_date: '2025-04-24', statement_balance: '100', gl_balance: '150',
  reconciled_balance: '150', difference: '-50', status: 'in_progress', started_by: 'u', started_at: 'now',
  created_at: 'now', updated_at: 'now',
};
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => [header]),
  withTransaction: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/reconciliationSessionLock', () => ({
  lockSessionForHeaderChange: vi.fn(async () => ({ id: 'rec-1', status: 'in_progress' })),
  refuseCompletedSession: vi.fn(), shareLockSession: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationBalance', () => ({
  updateReconciledBalance: vi.fn(), bankGlBalanceAsAt: vi.fn(), refreshReconciledBalanceIfFree: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationCommit', () => ({ commitReconciliation: vi.fn() }));

import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { completeReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { updateReconciledBalance } from '@/modules/accounting/services/bank/bankReconciliationBalance';
import { commitReconciliation } from '@/modules/accounting/services/bank/bankReconciliationCommit';
import { ReconciliationNotBalancedError } from '@/modules/accounting/services/bank/reconciliationBalanced';

beforeEach(() => {
  vi.clearAllMocks();
  // The first check passes (difference 0) and the completing write then finds the ledger moved.
  vi.mocked(commitReconciliation).mockRejectedValue(new ReconciliationNotBalancedError(-50));
});

describe('completeReconciliation — refusal refresh', () => {
  const firstCheckPasses = async () => {
    const { sql } = await import('@/lib/neon');
    vi.mocked(sql).mockResolvedValue([{ ...header, difference: '0' }] as never);
  };

  it('refreshes the header inside a savepoint and throws the refusal', async () => {
    await firstCheckPasses();
    await expect(completeReconciliation('c', 'rec-1', 'u')).rejects.toBeInstanceOf(ReconciliationNotBalancedError);
    expect(withSavepoint).toHaveBeenCalledWith('recon_refusal_refresh', expect.any(Function));
    expect(updateReconciledBalance).toHaveBeenCalledWith('c', 'rec-1');
  });

  it('a refresh that throws is logged and does not replace the refusal', async () => {
    await firstCheckPasses();
    // The first call is the pre-check recompute; only the refusal's own refresh fails.
    vi.mocked(updateReconciledBalance).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('refresh blew up'));
    await expect(completeReconciliation('c', 'rec-1', 'u')).rejects.toBeInstanceOf(ReconciliationNotBalancedError);
    expect(withSavepoint).toHaveBeenCalledTimes(1);
    expect(updateReconciledBalance).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('Failed to refresh reconciliation after refusal',
      expect.objectContaining({ id: 'rec-1' }), 'accounting');
  });
});
