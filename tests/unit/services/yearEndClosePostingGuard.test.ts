/**
 * The year-end close validates its own journal before writing it.
 *
 * `postClosingJournal` INSERTs at status='posted', so `createJournalEntry`'s
 * `validateJournalEntry` never runs over it and `trg_gl_je_balanced` (BEFORE
 * UPDATE only) never fires for it. Migration 627 admits `source = 'year_end'`,
 * and the reason that is safe is the check inside the poster — so the check
 * needs BEHAVIOURAL cover, not the source-text pin in
 * glEntrySourceConstraint.test.ts, which would pass on a commented-out call.
 *
 * The preview is mocked here because production code cannot produce an
 * unbalanced one: that is the point of the guard, which exists for the day it
 * can.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sql = Object.assign(vi.fn(), { transaction: vi.fn() });
  const tx = vi.fn();
  return { sql, tx, withTransaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

const buildPreviewMock = vi.fn();
vi.mock('@/modules/accounting/services/gl/yearEndJournalBuilder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/yearEndJournalBuilder')>()),
  buildPreview: (...a: unknown[]) => buildPreviewMock(...a),
  resolveRetainedEarnings: vi.fn(async () => ({
    id: 'eeeeeeee-0000-0000-0000-000000000009', accountCode: '3200', accountName: 'Retained Earnings',
  })),
}));
vi.mock('@/modules/accounting/services/gl/fiscalYearBasis', () => ({
  getFiscalYearStartMonth: vi.fn(async () => 1),
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodIdForDate: vi.fn(async () => 'ffffffff-0000-0000-0000-000000000008'),
}));

import * as neon from '@/lib/neon';
import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndCloseService';

const sqlMock = neon.sql as unknown as ReturnType<typeof vi.fn>;
const txMock = (neon as unknown as { tx: ReturnType<typeof vi.fn> }).tx;

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'cccccccc-0000-0000-0000-000000000003';

/**
 * No open periods, the year's date range, the two balance queries, then the
 * already-closed lookup (empty: this year has never been closed).
 */
function stubReadsUpToPreview() {
  sqlMock
    .mockResolvedValueOnce([])                                                        // open periods
    .mockResolvedValueOnce([{ start_date: '2026-01-01', end_date: '2026-12-31' }])     // range
    .mockResolvedValueOnce([])                                                        // revenue
    .mockResolvedValueOnce([])                                                        // expense
    .mockResolvedValueOnce([]);                                                       // findPostedClosingJournal
}

function preview(lines: Array<{ debit: number; credit: number }>) {
  return {
    entryDate: '2026-12-31',
    entryNumber: 'YE-2026',
    description: 'Year-End Closing: 2026',
    lines: lines.map((l, i) => ({
      accountId: `0000000${i}-0000-0000-0000-00000000000${i}`,
      accountCode: `40${i}0`, accountName: `Account ${i}`, ...l,
    })),
    totalDebit: lines.reduce((s, l) => s + l.debit, 0),
    totalCredit: lines.reduce((s, l) => s + l.credit, 0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
  txMock.mockReset();
  txMock.mockResolvedValue([{ id: 'entry-1', entry_number: 'YE-2026' }]);
});

describe('postClosingJournal refuses an invalid closing journal before writing', () => {
  it('refuses an UNBALANCED journal and writes nothing', async () => {
    stubReadsUpToPreview();
    buildPreviewMock.mockReturnValue(preview([{ debit: 900, credit: 0 }, { debit: 0, credit: 100 }]));

    await expect(closeFiscalYear(COMPANY, '2026', USER))
      .rejects.toThrow(/Year-end closing journal is invalid.*not balanced/s);
    // The refusal lands before the transaction opens: no INSERT, and above all
    // no period lock, which is the irreversible half.
    expect(txMock).not.toHaveBeenCalled();
  });

  it('refuses a NEGATIVE line and writes nothing', async () => {
    stubReadsUpToPreview();
    buildPreviewMock.mockReturnValue(preview([{ debit: -500, credit: 0 }, { debit: 0, credit: -500 }]));

    await expect(closeFiscalYear(COMPANY, '2026', USER))
      .rejects.toThrow(/Year-end closing journal is invalid/);
    expect(txMock).not.toHaveBeenCalled();
  });

  it('writes a balanced journal and locks the year', async () => {
    stubReadsUpToPreview();
    buildPreviewMock.mockReturnValue(preview([{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }]));

    const result = await closeFiscalYear(COMPANY, '2026', USER) as
      { closingEntry: { id: string }; periodsLockedInYear: number; alreadyClosed: boolean };
    expect(result.closingEntry.id).toBe('entry-1');
    expect(result.alreadyClosed).toBe(false);
    // Counted from the lock UPDATE's RETURNING, not asserted as a literal.
    expect(result.periodsLockedInYear).toBe(1);
    // header INSERT + 2 line INSERTs + the period lock
    expect(txMock).toHaveBeenCalledTimes(4);
  });
});

/** A duplicate-key violation shaped exactly like the one the index raises. */
function entryNumberConflict(): Error {
  return Object.assign(new Error(
    'duplicate key value violates unique constraint "uq_gl_je_company_entry_number"',
  ), { code: '23505', constraint: 'uq_gl_je_company_entry_number' });
}

/** A gl_journal_entries header row as `SELECT *` returns it. */
function header(o: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'entry-1', entry_number: 'YE-2026', source: 'year_end', status: 'posted', ...o };
}

describe('a DORMANT year is closed, not refused for want of a period to stamp', () => {
  it('never resolves a fiscal period when there is no journal to stamp', async () => {
    // The close writes no journal for a year with no posted P&L — it only locks
    // the periods. Resolving the period anyway meant a `no_fiscal_period`
    // refusal could block a close that would have stamped nothing.
    stubReadsUpToPreview();
    buildPreviewMock.mockReturnValue(preview([]));

    const result = await closeFiscalYear(COMPANY, '2026', USER) as
      { closingEntry: null; alreadyClosed: boolean; unclosedNetIncome: number; message: string };

    expect(getFiscalPeriodIdForDate).not.toHaveBeenCalled();
    expect(result.closingEntry).toBeNull();
    expect(result.alreadyClosed).toBe(false);
    expect(result.unclosedNetIncome).toBe(0);
    expect(result.message).toMatch(/no closing journal was needed/);
    // Only the period lock ran inside the transaction.
    expect(txMock).toHaveBeenCalledTimes(1);
  });
});

describe('two simultaneous closes: the ledger holds, and the loser tells the truth', () => {
  it('reports the WINNER as already closed instead of a raw 23505', async () => {
    // The already-closed lookup is a separate statement from the INSERT, so
    // both callers read `null` and both reach the write. The unique index keeps
    // the ledger to one journal; what the loser must not do is answer 500 for a
    // year that is now correctly closed.
    stubReadsUpToPreview();
    sqlMock
      .mockResolvedValueOnce([header({ id: 'winner' })])   // re-read after the conflict
      .mockResolvedValueOnce([{ n: 12 }])                  // periods currently locked
      .mockResolvedValueOnce([])                           // residual: revenue, re-read
      .mockResolvedValueOnce([]);                          // residual: expense, re-read
    buildPreviewMock.mockReturnValue(preview([{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }]));
    txMock.mockReset();
    txMock.mockRejectedValueOnce(entryNumberConflict());

    const result = await closeFiscalYear(COMPANY, '2026', USER) as
      { alreadyClosed: boolean; closingEntry: { id: string }; periodsLockedInYear: number };

    expect(result.alreadyClosed).toBe(true);
    expect(result.closingEntry.id).toBe('winner');
    expect(result.periodsLockedInYear).toBe(12);
    // Re-read AFTER the winner's journal exists, not taken from the netIncome
    // this call computed before it: the loser must not report the P&L the
    // winner has just moved into equity as money left outside it.
    expect((result as unknown as { unclosedNetIncome: number }).unclosedNetIncome).toBe(0);
  });

  it('REFUSES BY NAME when a squatter took the number between the lookup and the INSERT', async () => {
    // A squatter that appeared in that window is not a close, and calling it
    // one would be the lie the branch exists to avoid — but rethrowing the
    // 23505 answers HTTP 500 "Failed to process year-end", which is the exact
    // opacity `closing_entry_number_taken` was written to remove. It differs
    // from the squatter the lookup catches only in timing, so it earns the
    // same typed refusal.
    stubReadsUpToPreview();
    sqlMock.mockResolvedValueOnce([header({ id: 'squatter', source: 'manual' })]);
    buildPreviewMock.mockReturnValue(preview([{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }]));
    txMock.mockReset();
    txMock.mockRejectedValueOnce(entryNumberConflict());

    const result = await closeFiscalYear(COMPANY, '2026', USER) as
      { error: string; entryId: string; source: string; status: string; entryNumber: string };

    expect(result.error).toBe('closing_entry_number_taken');
    expect(result.entryId).toBe('squatter');
    expect(result.source).toBe('manual');
    expect(result.entryNumber).toBe('YE-2026');
  });

  it('REFUSES a DRAFT year_end winner as not-posted rather than reporting the year closed', async () => {
    // A draft or reversed `year_end` row holding the number means the year is
    // NOT closed and cannot be closed while it sits there. Reporting it as
    // alreadyClosed would lie twice: nothing was posted, and nothing ever will
    // be until a person renumbers it.
    stubReadsUpToPreview();
    sqlMock.mockResolvedValueOnce([header({ id: 'draft-close', status: 'draft' })]);
    buildPreviewMock.mockReturnValue(preview([{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }]));
    txMock.mockReset();
    txMock.mockRejectedValueOnce(entryNumberConflict());

    const result = await closeFiscalYear(COMPANY, '2026', USER) as
      { error: string; entryId: string; status: string };

    expect(result.error).toBe('closing_journal_not_posted');
    expect(result.entryId).toBe('draft-close');
    expect(result.status).toBe('draft');
  });

  it('RETHROWS the 23505 when NOTHING holds the number on the re-read', async () => {
    // Then the conflict is not the one this branch explains — the row was
    // deleted, or the violation came from somewhere else entirely — and
    // dressing it up as a closed year would report a close that never happened.
    stubReadsUpToPreview();
    sqlMock.mockResolvedValueOnce([]);
    buildPreviewMock.mockReturnValue(preview([{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }]));
    txMock.mockReset();
    txMock.mockRejectedValueOnce(entryNumberConflict());

    await expect(closeFiscalYear(COMPANY, '2026', USER))
      .rejects.toThrow(/uq_gl_je_company_entry_number/);
  });

  it('RETHROWS a failure that is not the entry-number conflict', async () => {
    stubReadsUpToPreview();
    buildPreviewMock.mockReturnValue(preview([{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }]));
    txMock.mockReset();
    txMock.mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }));

    await expect(closeFiscalYear(COMPANY, '2026', USER)).rejects.toThrow(/deadlock detected/);
  });
});

describe('a journal of ANOTHER source holding YE-<year> is a typed refusal, not a 500', () => {
  it('names the squatting journal and writes nothing', async () => {
    // uq_gl_je_company_entry_number has no predicate on source, so a manual
    // journal numbered YE-2026 blocks the INSERT just as hard as a real close.
    sqlMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ start_date: '2026-01-01', end_date: '2026-12-31' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([header({ id: 'squatter', source: 'manual', status: 'posted' })]);
    buildPreviewMock.mockReturnValue(preview([{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }]));

    const result = await closeFiscalYear(COMPANY, '2026', USER) as
      { error: string; entryId: string; source: string; status: string; entryNumber: string };

    expect(result.error).toBe('closing_entry_number_taken');
    expect(result.entryId).toBe('squatter');
    expect(result.source).toBe('manual');
    expect(result.entryNumber).toBe('YE-2026');
    expect(txMock).not.toHaveBeenCalled();
  });
});
