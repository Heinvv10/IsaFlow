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
      { closingEntry: { id: string }; periodsLocked: number; alreadyClosed: boolean };
    expect(result.closingEntry.id).toBe('entry-1');
    expect(result.alreadyClosed).toBe(false);
    // Counted from the lock UPDATE's RETURNING, not asserted as a literal.
    expect(result.periodsLocked).toBe(1);
    // header INSERT + 2 line INSERTs + the period lock
    expect(txMock).toHaveBeenCalledTimes(4);
  });
});
