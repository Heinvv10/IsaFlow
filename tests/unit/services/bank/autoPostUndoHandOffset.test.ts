/**
 * R-079 — `undoRun` refuses a row whose posting a manual journal already
 * offsets (`offsetByHand`), and re-reads each row under its lock so a peer undo
 * or a confirmed hand correction cannot be applied on top. The SQL is proved
 * on the fixture DB (r079-*.int.test.ts); this pins the decision in TS.
 */
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

// The row lock re-reads the line; by default it finds it exactly as the
// run's SELECT did, still tagged. A test overrides it to model a peer.
const lockMock = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankTxLock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/bank/bankTxLock')>()),
  lockBankTransactionForUpdate: (...a: unknown[]) => lockMock(...a),
}));

import { undoRun } from '@/modules/accounting/services/bank/autoPostUndoService';

const NO_SKIPS = { reconciled: 0, contended: 0, failed: 0, offsetByHand: 0 };

function routeSql(handlers: Array<{ match: RegExp; rows: unknown[] }>) {
  const tagged = handlers.find((h) => /auto_post_run_id/.test(h.match.source))?.rows as Array<{ id: string }> | undefined;
  lockMock.mockImplementation(async (_co: string, id: string) => {
    const row = tagged?.find((r) => r.id === id);
    return row ? { ...row, auto_post_run_id: 'run-1' } : null;
  });
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    const h = handlers.find((x) => x.match.test(text));
    return Promise.resolve(h ? h.rows : []);
  });
}

describe('undoRun — hand offsets (R-079)', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    reverseReconciledTransaction.mockReset();
    reverseJournalEntry.mockReset();
    lockMock.mockReset();
  });

  // A manual journal already offsets the posting: reversing it too
  // would apply the user's correction twice. Refused, nothing posted, the tag
  // and the run stay, and the journal is named.
  const provisionalRow = { id: 't1', status: 'provisional', matched_journal_line_id: null, provisional_je_id: 'je-1' };
  const candidate = (flags: Record<string, boolean>) => ({
    id: 'je-hand', entry_number: 'JE-2026-00042',
    linked: false, by_person: true, claimed_elsewhere: false, within_posting: true, ...flags,
  });

  it('refuses a row a manual journal already offsets, and names the journal', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [provisionalRow] },
      { match: /WITH posting AS/, rows: [candidate({})] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toEqual({
      reversed: 0, skipped: 1, skippedBy: { ...NO_SKIPS, offsetByHand: 1 }, alreadyUndone: 0, undone: false,
      handOffsets: [{ transactionId: 't1', journalEntryId: 'je-hand', entryNumber: 'JE-2026-00042' }],
    });
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /SET auto_post_run_id = NULL/.test(t))).toBe(false);
    expect(joined.some((t) => /UPDATE bank_auto_post_runs/.test(t))).toBe(false);
  });

  it('refuses a LINKED journal even when it reaches beyond the posting', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [provisionalRow] },
      { match: /WITH posting AS/, rows: [candidate({ linked: true, by_person: false, within_posting: false })] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r.skippedBy.offsetByHand).toBe(1);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  // The other direction: without a link, a journal is an offset only when a
  // person made it, no other bank line owns it, AND it lies within the posting.
  it.each([
    ['made by the system', { by_person: false }],
    ["owned by another bank line", { claimed_elsewhere: true }],
    ['reaching an account the posting never touched', { within_posting: false }],
  ])('does not block the undo for a journal %s', async (_name, flags) => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [provisionalRow] },
      { match: /WITH posting AS/, rows: [candidate(flags)] },
    ]);

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
    expect(reverseJournalEntry).toHaveBeenCalledWith('co-1', 'je-1', 'u-1');
  });

  // A peer undo or a confirmed hand correction took the row out of the run
  // between the SELECT and the lock: nothing to do, and nothing to count.
  it('leaves a row alone that the lock finds no longer in the run', async () => {
    routeSql([
      { match: /FROM bank_auto_post_runs/, rows: [{ id: 'run-1', undone_at: null }] },
      { match: /FROM bank_transactions\s+WHERE auto_post_run_id/, rows: [provisionalRow] },
    ]);
    lockMock.mockResolvedValue({ ...provisionalRow, auto_post_run_id: null });

    const r = await undoRun('co-1', 'run-1', 'u-1');

    expect(r).toMatchObject({ reversed: 0, skipped: 0, alreadyUndone: 0 });
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    const joined = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(joined.some((t) => /SET status = 'imported'/.test(t))).toBe(false);
  });
});
