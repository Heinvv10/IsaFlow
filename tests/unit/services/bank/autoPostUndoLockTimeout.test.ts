/**
 * D8 round 11 (census of the routes that reach a D8 flow): since round 10 `reverseReconciledTransaction` runs under a
 * flow lock budget, so a peer holding a bill or invoice the unwind touches answers `RowLockTimeoutError` after 5 s
 * (and the provisional path's `reverseJournalEntry` `JournalReversalLockTimeoutError`). The undo counted those as
 * FAILED rows — "manual reversal required", at error level — where a held bank line is a contended skip. Every
 * lock timeout is now contention: skipped and counted, and re-thrown when nothing was written (the route's 503).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }) }));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(),
  transaction: vi.fn(),
  withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const reverseReconciledTransaction = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  reverseReconciledTransaction: (...a: unknown[]) => reverseReconciledTransaction(...a),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ reverseJournalEntry: vi.fn() }));
const lockMock = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankTxLock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/bank/bankTxLock')>()),
  lockBankTransactionForUpdate: (...a: unknown[]) => lockMock(...a),
}));

import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import { JournalReversalLockTimeoutError } from '@/modules/accounting/services/gl/journalEntryReversalClaim';

const ROWS = [
  { id: 't1', status: 'allocated', matched_journal_line_id: 'jl-1', provisional_je_id: null },
  { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
];

beforeEach(() => {
  sqlMock.mockReset();
  reverseReconciledTransaction.mockReset();
  lockMock.mockReset();
  lockMock.mockImplementation(async (_c: string, id: string) => ({ ...ROWS.find((r) => r.id === id), auto_post_run_id: 'run-1' }));
  const handlers: [RegExp, unknown[]][] = [
    [/FROM bank_auto_post_runs/, [{ id: 'run-1', undone_at: null }]],
    [/FROM bank_transactions\s+WHERE auto_post_run_id/, ROWS],
    [/SELECT journal_entry_id FROM gl_journal_lines/, [{ journal_entry_id: 'je-of-line' }]],
    [/WITH RECURSIVE reversal_chain/, [{ depth: 0 }]],
  ];
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    return Promise.resolve(handlers.find(([m]) => m.test(text))?.[1] ?? []);
  });
});

describe.each([
  ['RowLockTimeoutError (the flow budget)', () => new RowLockTimeoutError('Bank transaction t2')],
  ['JournalReversalLockTimeoutError (the chain head)', () => new JournalReversalLockTimeoutError('je-of-line')],
  // D11 round 3: a deadlock victim is contention too, not a permanent "manual reversal required" failure.
  ['a raw 40P01 deadlock victim', () => Object.assign(new Error('deadlock detected'), { code: '40P01' })],
  ['a raw 55P03 lock timeout', () => Object.assign(new Error('lock timeout'), { code: '55P03' })],
])('undoRun meets a %s', (_name, make) => {
  it('skips the row as contended, not failed, and keeps the reversed one', async () => {
    reverseReconciledTransaction.mockResolvedValueOnce({}).mockRejectedValueOnce(make());
    const r = await undoRun('co-1', 'run-1', 'u-1');
    expect(r.reversed).toBe(1);
    expect(r.skippedBy).toMatchObject({ contended: 1, failed: 0 });
    expect(r.undone).toBe(false);
  });

  it('re-throws it when no row was written, for the route\'s retryable answer', async () => {
    const err = make();
    reverseReconciledTransaction.mockRejectedValue(err);
    await expect(undoRun('co-1', 'run-1', 'u-1')).rejects.toBe(err);
  });
});
