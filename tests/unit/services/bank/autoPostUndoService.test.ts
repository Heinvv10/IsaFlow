import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const reverseReconciledTransaction = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  reverseReconciledTransaction: (...a: unknown[]) => reverseReconciledTransaction(...a),
}));
const reverseJournalEntry = vi.fn();
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  reverseJournalEntry: (...a: unknown[]) => reverseJournalEntry(...a),
}));

import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';

function routeSql(handlers: Array<{ match: RegExp; rows: unknown[] }>) {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    const h = handlers.find((x) => x.match.test(text));
    return Promise.resolve(h ? h.rows : []);
  });
}

describe('undoRun', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    reverseReconciledTransaction.mockReset();
    reverseJournalEntry.mockReset();
  });

  it('rejects a run that is already undone', async () => {
    routeSql([{ match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: '2026-06-10T00:00:00Z' }] }]);
    await expect(undoRun('co-1', 'run-1', 'u-1')).rejects.toThrow(/already undone/i);
  });

  it('throws when the run does not belong to the company', async () => {
    routeSql([{ match: /FROM bank_auto_post_runs/, rows: [] }]);
    await expect(undoRun('co-1', 'run-x', 'u-1')).rejects.toThrow(/not found/i);
  });

  it('skips reconciled txs and reverses the rest', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'reconciled', matched_journal_line_id: 'jl-1', provisional_je_id: null },
        { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
        { id: 't3', status: 'provisional', matched_journal_line_id: null, provisional_je_id: 'je-3' },
      ] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({ reversed: 2, skipped: 1 });
    expect(reverseReconciledTransaction).toHaveBeenCalledWith('co-1', 't2', 'u-1');
    expect(reverseJournalEntry).toHaveBeenCalledWith('co-1', 'je-3', 'u-1');
    expect(reverseReconciledTransaction).not.toHaveBeenCalledWith('co-1', 't1', 'u-1');

    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /SET status = 'imported', provisional_je_id = NULL/.test(t))).toBe(true);
    expect(joined.some((t) => /SET auto_post_run_id = NULL/.test(t))).toBe(true);
  });

  // K-071 r15. The bank-line lock `reverseReconciledTransaction` takes runs on
  // the REQUEST transaction, so contention has aborted it: swallowed, the next
  // statement raised 25P02 and the route answered 400 "Undo failed". It must
  // end the undo — and must not mark the run undone, or it can never be retried.
  it('re-throws contention and does not mark the run undone', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'allocated', matched_journal_line_id: 'jl-1', provisional_je_id: null },
        { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
      ] },
    ]);
    const contended = new BankTransactionLockTimeoutError('t2');
    reverseReconciledTransaction.mockResolvedValueOnce({}).mockRejectedValueOnce(contended);

    await expect(undoRun('co-1', 'run-1', 'u-1')).rejects.toBe(contended);

    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(false);
  });

  // The other direction: a non-contention failure keeps the documented
  // behaviour — logged, counted as skipped, and the run is still marked undone.
  it('still skips a non-contention failure and marks the run undone', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'allocated', matched_journal_line_id: 'jl-1', provisional_je_id: null },
        { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
      ] },
    ]);
    reverseReconciledTransaction.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Cannot reverse: period closed'));

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({ reversed: 1, skipped: 1 });
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(true);
  });
});
