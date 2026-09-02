/**
 * Unit tests for cancelReconciliation (bankReconciliationCancelService.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, withTransactionMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') }),
  withTransactionMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: withTransactionMock,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  cancelReconciliation,
  ReconciliationNotCancellableError,
} from '@/modules/accounting/services/bank/bankReconciliationCancelService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const RECON_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const USER_ID = 'ffffffff-0000-0000-0000-000000000006';

/** Queues the sequential `sql` results the service reads before the transaction. */
function queuePreChecks(opts: {
  recon?: Record<string, unknown>[];
  adjustments?: number;
  reconciled?: number;
} = {}) {
  const recon = opts.recon ?? [{ id: RECON_ID, status: 'in_progress' }];
  sqlMock.mockReset();
  sqlMock
    .mockResolvedValueOnce(recon)
    .mockResolvedValueOnce([{ cnt: opts.adjustments ?? 0 }])
    .mockResolvedValueOnce([{ cnt: opts.reconciled ?? 0 }]);
}

/** Runs the transaction body against a tx mock returning the given row sets. */
function runTxWith(rowSets: Record<string, unknown>[][]) {
  const txMock = vi.fn();
  for (const rows of rowSets) txMock.mockResolvedValueOnce(rows);
  withTransactionMock.mockReset();
  withTransactionMock.mockImplementation((fn: (tx: unknown) => unknown) => fn(txMock));
  return txMock;
}

beforeEach(() => {
  sqlMock.mockReset();
  withTransactionMock.mockReset();
});

describe('cancelReconciliation', () => {
  it('refuses when the reconciliation does not exist', async () => {
    queuePreChecks({ recon: [] });
    await expect(cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(ReconciliationNotCancellableError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses to cancel a completed reconciliation', async () => {
    queuePreChecks({ recon: [{ id: RECON_ID, status: 'completed' }] });
    await expect(cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/in-progress/i);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('the DELETE carries its own adjustment guard, so a racing journal still refuses', async () => {
    // The pre-check runs BEFORE the transaction opens. An adjustment committed
    // between the two would slip past it, and without the re-assertion the
    // DELETE would remove the header under a posted journal that names it.
    // Here the pre-check sees zero adjustments (the race window) and the DELETE
    // returns no row, exactly as the NOT EXISTS clause makes it.
    queuePreChecks({ adjustments: 0 });
    runTxWith([
      [{ id: 'tx-1' }],  // reverted
      [{ id: 'tx-1' }],  // detached
      [],                // DELETE matched nothing — the guard refused
    ]);

    await expect(cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/completed, or an adjustment/);
  });

  it('re-asserts BOTH conditions inside the DELETE statement itself', async () => {
    // Structural, deliberately: the clause only changes behaviour under a race
    // that cannot be staged against a real Postgres from here. Pinning the
    // statement is what stops the guard silently reverting to advisory.
    queuePreChecks({ adjustments: 0 });
    const tx = runTxWith([[], [], [{ id: RECON_ID }]]);

    await cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID);

    const deleteCall = tx.mock.calls.find(
      (c) => String((c[0] as TemplateStringsArray).join('?')).includes('DELETE FROM bank_reconciliations'),
    );
    expect(deleteCall).toBeDefined();
    const text = String((deleteCall![0] as TemplateStringsArray).join('?'));
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('gl_journal_entries');
    expect(text).toContain("status = 'in_progress'");
    expect(text).toContain("'posted', 'draft'");
  });

  it('counts DRAFT adjustments in the pre-check, not just posted ones', async () => {
    // A draft is what createAdjustmentEntry leaves behind when the insert
    // succeeds and the post fails; cancelling under it would let that draft be
    // posted later against a header that no longer exists.
    queuePreChecks({ adjustments: 0 });
    runTxWith([[], [], [{ id: RECON_ID }]]);
    await cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID);

    const preCheck = sqlMock.mock.calls.find(
      (c) => String((c[0] as TemplateStringsArray).join('?')).includes('FROM gl_journal_entries'),
    );
    expect(preCheck).toBeDefined();
    expect(String((preCheck![0] as TemplateStringsArray).join('?'))).toContain("'posted', 'draft'");
  });

  it('refuses while posted adjustment journals reference it', async () => {
    queuePreChecks({ adjustments: 2 });
    await expect(cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/2 posted adjustment journals/);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses when reconciled transactions are attached', async () => {
    queuePreChecks({ reconciled: 1 });
    await expect(cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/reconciled transactions/);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('reverts matches, detaches the rest and deletes the header', async () => {
    queuePreChecks();
    const txMock = runTxWith([
      [{ id: 'tx-1' }, { id: 'tx-2' }],   // matched -> imported
      [{ id: 'tx-3' }],                    // remaining detached
      [{ id: RECON_ID }],                  // deleted header
    ]);

    const result = await cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID);

    expect(result).toEqual({ revertedMatches: 2, releasedTransactions: 3 });
    expect(txMock).toHaveBeenCalledTimes(3);
    const revertSql = String(txMock.mock.calls[0]![0].join('?'));
    expect(revertSql).toContain("status = 'imported'");
    expect(revertSql).toContain('matched_journal_line_id = NULL');
    expect(revertSql).toContain("status = 'matched'");
    expect(revertSql).toContain('company_id');
    const detachSql = String(txMock.mock.calls[1]![0].join('?'));
    expect(detachSql).not.toContain('status =');
    const deleteSql = String(txMock.mock.calls[2]![0].join('?'));
    expect(deleteSql).toContain('DELETE FROM bank_reconciliations');
    expect(deleteSql).toContain("status = 'in_progress'");
    expect(deleteSql).toContain('company_id');
  });

  it('throws when the header vanished or completed mid-cancel', async () => {
    queuePreChecks();
    runTxWith([[], [], []]);
    await expect(cancelReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/changed while cancelling/);
  });
});
