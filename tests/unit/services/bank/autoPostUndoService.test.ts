import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(),
  transaction: vi.fn(),
  // Pass-through, matching the real helper's behaviour with no ALS client.
  withSavepoint: (_name: string, fn: () => Promise<unknown>) => fn(),
}));
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

  it('skips reconciled txs, reverses the rest, and leaves the run open', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'reconciled', matched_journal_line_id: 'jl-1', provisional_je_id: null },
        { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
        { id: 't3', status: 'provisional', matched_journal_line_id: null, provisional_je_id: 'je-3' },
      ] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    // The reconciled row is still posted and still tagged — the run is not undone.
    expect(r).toEqual({
      reversed: 2, skipped: 1, skippedBy: { reconciled: 1, contended: 0, failed: 0 }, alreadyUndone: 0, undone: false,
    });
    expect(reverseReconciledTransaction).toHaveBeenCalledWith('co-1', 't2', 'u-1');
    expect(reverseJournalEntry).toHaveBeenCalledWith('co-1', 'je-3', 'u-1');
    expect(reverseReconciledTransaction).not.toHaveBeenCalledWith('co-1', 't1', 'u-1');

    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /SET status = 'imported', provisional_je_id = NULL/.test(t))).toBe(true);
    expect(joined.some((t) => /SET auto_post_run_id = NULL/.test(t))).toBe(true);
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(false);
  });

  it('marks the run undone when every row was reversed', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'allocated', matched_journal_line_id: 'jl-1', provisional_je_id: null },
      ] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({
      reversed: 1, skipped: 0, skippedBy: { reconciled: 0, contended: 0, failed: 0 }, alreadyUndone: 0, undone: true,
    });
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(true);
  });

  // K-071 r19. Each row runs in its own savepoint, so a contended row rolls
  // back alone: it is skipped and counted, the rows already reversed stand, and
  // the run stays open so a retry finishes it.
  it('skips a contended row, keeps the reversed one, and leaves the run open', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'allocated', matched_journal_line_id: 'jl-1', provisional_je_id: null },
        { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
      ] },
    ]);
    const contended = new BankTransactionLockTimeoutError('t2');
    reverseReconciledTransaction.mockResolvedValueOnce({}).mockRejectedValueOnce(contended);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({
      reversed: 1, skipped: 1, skippedBy: { reconciled: 0, contended: 1, failed: 0 }, alreadyUndone: 0, undone: false,
    });
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(false);
  });

  // Every row contended: nothing was written, so the contention is re-thrown
  // for the route's 409 — a 200 would report an undo that did nothing.
  it('re-throws contention when no row was written', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'reconciled', matched_journal_line_id: 'jl-1', provisional_je_id: null },
        { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
      ] },
    ]);
    const contended = new BankTransactionLockTimeoutError('t2');
    reverseReconciledTransaction.mockRejectedValueOnce(contended);

    await expect(undoRun('co-1', 'run-1', 'u-1')).rejects.toBe(contended);

    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(false);
  });

  // A non-contention failure is logged and skipped too, and is never
  // re-thrown. Marking the run undone over it was the K-140 M-5 defect this
  // test used to pin: the failed row is still posted, so the run stays open.
  it('skips a non-contention failure and leaves the run open', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'allocated', matched_journal_line_id: 'jl-1', provisional_je_id: null },
        { id: 't2', status: 'allocated', matched_journal_line_id: 'jl-2', provisional_je_id: null },
      ] },
    ]);
    reverseReconciledTransaction.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Cannot reverse: period closed'));

    const r = await undoRun('co-1', 'run-1', 'u-1');

    // `alreadyUndone` is master's third counter — a row whose journal was
    // reversed before this run reached it. Nothing here is in that state.
    expect(r).toEqual({
      reversed: 1, skipped: 1, skippedBy: { reconciled: 0, contended: 0, failed: 1 }, alreadyUndone: 0, undone: false,
    });
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(false);
  });

  // K-071 r21. A provisional JE the user already reversed by hand has nothing
  // left to undo. Reversing it again is refused ("already reversed") on every
  // retry, so it was counted as a failure forever and the run never closed.
  it('finishes a row whose provisional JE was already reversed, without reversing it again', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status: 'allocated', matched_journal_line_id: null, provisional_je_id: 'je-1' },
      ] },
      { match: /SELECT reversed_at FROM gl_journal_entries/, rows: [{ reversed_at: '2026-09-10T00:00:00Z' }] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({
      reversed: 0, skipped: 0, skippedBy: { reconciled: 0, contended: 0, failed: 0 }, alreadyUndone: 1, undone: true,
    });
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /SET status = 'imported', provisional_je_id = NULL/.test(t))).toBe(true);
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(true);
  });

  // The other direction: a row still marked posted with NOTHING linked is not
  // "already undone" — clearing its tag would let the run read undone over a
  // line the books still show as allocated.
  it.each(['allocated', 'matched'])('skips a %s row with nothing linked and leaves the run open', async (status) => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't1', status, matched_journal_line_id: null, provisional_je_id: null },
      ] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({
      reversed: 0, skipped: 1, skippedBy: { reconciled: 0, contended: 0, failed: 1 }, alreadyUndone: 0, undone: false,
    });
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /SET auto_post_run_id = NULL/.test(t))).toBe(false);
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(false);
  });
});
