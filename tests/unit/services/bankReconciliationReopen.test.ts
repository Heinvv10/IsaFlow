/**
 * Unit tests for reopenReconciliation (bankReconciliationReopenService.ts, R-111)
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
  reopenReconciliation,
  ReconciliationNotReopenableError,
} from '@/modules/accounting/services/bank/bankReconciliationReopenService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const RECON_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const USER_ID = 'ffffffff-0000-0000-0000-000000000006';
const BANK_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

const COMPLETED = {
  id: RECON_ID, status: 'completed', bank_account_id: BANK_ID,
  statement_date: '2026-08-24', completed_at: '2026-10-01T10:00:00Z',
};

/** Queues the sequential `sql` reads the service makes before the transaction. */
function queueReads(opts: {
  recon?: Record<string, unknown>[];
  later?: number;
  open?: Record<string, unknown>[];
  projected?: { allocated: number; matched: number };
} = {}) {
  sqlMock.mockReset();
  sqlMock
    .mockResolvedValueOnce(opts.recon ?? [COMPLETED])
    .mockResolvedValueOnce([{ cnt: opts.later ?? 0, newest: '2026-09-24' }])
    .mockResolvedValueOnce(opts.open ?? []);
  if (opts.projected) sqlMock.mockResolvedValueOnce([opts.projected]);
}

function runTxWith(rowSets: Record<string, unknown>[][]) {
  const txMock = vi.fn();
  for (const rows of rowSets) txMock.mockResolvedValueOnce(rows);
  withTransactionMock.mockReset();
  withTransactionMock.mockImplementation((fn: (tx: unknown) => unknown) => fn(txMock));
  return txMock;
}

/** The SQL text of a tagged-template call, for asserting statement shape. */
function sqlText(call: unknown[]): string {
  return (call[0] as string[]).join('?');
}

beforeEach(() => {
  sqlMock.mockReset();
  withTransactionMock.mockReset();
});

describe('reopenReconciliation', () => {
  it('refuses when the reconciliation does not exist', async () => {
    queueReads({ recon: [] });
    await expect(reopenReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(ReconciliationNotReopenableError);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses an in-progress reconciliation — it is already open', async () => {
    queueReads({ recon: [{ ...COMPLETED, status: 'in_progress' }] });
    await expect(reopenReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/only a completed/i);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses when a later completed reconciliation stands on the account, naming it', async () => {
    queueReads({ later: 2 });
    await expect(reopenReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/2 later completed reconciliations.*2026-09-24.*newest first/);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('refuses when a session is already in progress on the account', async () => {
    queueReads({ open: [{ id: 'cccccccc-0000-0000-0000-000000000009' }] });
    await expect(reopenReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/already in progress/);
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('dry run reports what would be restored and writes nothing', async () => {
    queueReads({ projected: { allocated: 726, matched: 3 } });
    const res = await reopenReconciliation(COMPANY_ID, RECON_ID, USER_ID, { dryRun: true });
    expect(res).toEqual({
      bankAccountId: BANK_ID, statementDate: '2026-08-24', restoredAllocated: 726, restoredMatched: 3,
    });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });

  it('reopens the header and restores allocated and matched lines from allocation_type', async () => {
    queueReads();
    const tx = runTxWith([
      [{ id: RECON_ID }],
      [{ status: 'allocated' }, { status: 'allocated' }, { status: 'matched' }],
    ]);
    const res = await reopenReconciliation(COMPANY_ID, RECON_ID, USER_ID, { reason: 'fuel VAT recode' });
    expect(res.restoredAllocated).toBe(2);
    expect(res.restoredMatched).toBe(1);

    const header = sqlText(tx.mock.calls[0]!);
    expect(header).toMatch(/SET status = 'in_progress', completed_by = NULL, completed_at = NULL/);
    expect(header).toMatch(/reopen_reason = /);
    // The guards are re-asserted inside the statement, not only read beforehand.
    expect(header).toMatch(/br\.status = 'completed'/);
    expect(header).toMatch(/other\.status = 'in_progress'/);
    expect(header).toMatch(/other\.statement_date > br\.statement_date/);
    expect(tx.mock.calls[0]).toContain('fuel VAT recode');

    const lines = sqlText(tx.mock.calls[1]!);
    expect(lines).toMatch(/CASE WHEN allocation_type IS NOT NULL THEN 'allocated' ELSE 'matched' END/);
    // Only this session's reconciled lines: Sage-reconciled lines carry no reconciliation_id.
    expect(lines).toMatch(/WHERE reconciliation_id = /);
    expect(lines).toMatch(/AND status = 'reconciled'/);
  });

  it('rolls back when the header guard loses a race, restoring no lines', async () => {
    queueReads();
    const tx = runTxWith([[]]);
    await expect(reopenReconciliation(COMPANY_ID, RECON_ID, USER_ID))
      .rejects.toThrow(/changed while reopening/);
    expect(tx).toHaveBeenCalledTimes(1);
  });
});
