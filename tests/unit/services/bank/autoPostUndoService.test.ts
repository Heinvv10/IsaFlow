import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const reverseReconciledTransaction = vi.fn();
// A provisional entry is reversed through the controlled reversal of its owning allocation, which also returns the
// bank line to the queue; a direct reverseJournalEntry is refused for a generated journal and poisons the request.
const reverseProvisionalEntry = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  reverseReconciledTransaction: (...a: unknown[]) => reverseReconciledTransaction(...a),
  reverseProvisionalEntry: (...a: unknown[]) => reverseProvisionalEntry(...a),
}));

import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';

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
    reverseProvisionalEntry.mockReset();
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
    expect(reverseProvisionalEntry).toHaveBeenCalledWith('co-1', 'je-3', 'u-1', { reason: 'Auto-post run undone' });
    expect(reverseReconciledTransaction).not.toHaveBeenCalledWith('co-1', 't1', 'u-1');

    // The status/provisional-link reset is the controlled reversal's own write, under its receipt; only the run tag is
    // cleared here.
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /SET status = 'imported', provisional_je_id = NULL/.test(t))).toBe(false);
    expect(joined.some((t) => /SET auto_post_run_id = NULL/.test(t))).toBe(true);
  });

  it('takes the provisional path for a row carrying BOTH a bank line and a provisional entry', async () => {
    // A controlled provisional posting deliberately carries both: the bank line is what its reversal proves the
    // original allocation by. Taking the matched-line branch for such a row would miss every entry that predates the
    // controls, whose allocation has no intent to reverse against.
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [
        { id: 't4', status: 'provisional', matched_journal_line_id: 'jl-4', provisional_je_id: 'je-4' },
      ] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({ reversed: 1, skipped: 0 });
    expect(reverseProvisionalEntry).toHaveBeenCalledWith('co-1', 'je-4', 'u-1', { reason: 'Auto-post run undone' });
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });
});
