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
import { postClosingJournal } from '@/modules/accounting/services/gl/yearEndJournalPoster';

const sqlMock = neon.sql as unknown as ReturnType<typeof vi.fn>;
const txMock = (neon as unknown as { tx: ReturnType<typeof vi.fn> }).tx;

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'cccccccc-0000-0000-0000-000000000003';

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

/**
 * Driven at `postClosingJournal` itself rather than through `closeFiscalYear`.
 *
 * The guard under test has always lived in the poster; the close's own
 * orchestration is what moved (it is now `controlledYearEnd`, which refuses
 * without an authenticated control transaction). The assertions are unchanged:
 * same inputs, same refusal text, same "no transaction opened" proof.
 */
const PERIOD = 'ffffffff-0000-0000-0000-000000000008';

describe('postClosingJournal refuses an invalid closing journal before writing', () => {
  it('refuses an UNBALANCED journal and writes nothing', async () => {
    await expect(postClosingJournal(COMPANY, USER, '2026',
      preview([{ debit: 900, credit: 0 }, { debit: 0, credit: 100 }]), PERIOD))
      .rejects.toThrow(/Year-end closing journal is invalid.*not balanced/s);
    // The refusal lands before the transaction opens: no INSERT, and above all
    // no period lock, which is the irreversible half.
    expect(txMock).not.toHaveBeenCalled();
  });

  it('refuses a NEGATIVE line and writes nothing', async () => {
    await expect(postClosingJournal(COMPANY, USER, '2026',
      preview([{ debit: -500, credit: 0 }, { debit: 0, credit: -500 }]), PERIOD))
      .rejects.toThrow(/Year-end closing journal is invalid/);
    expect(txMock).not.toHaveBeenCalled();
  });

  it('writes a balanced journal and locks the year', async () => {
    const result = await postClosingJournal(COMPANY, USER, '2026',
      preview([{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }]), PERIOD);
    expect((result.entry as { id: string }).id).toBe('entry-1');
    // Counted from the lock UPDATE's RETURNING, not asserted as a literal.
    expect(result.periodsLocked).toBe(1);
    // header INSERT + 2 line INSERTs + the period lock
    expect(txMock).toHaveBeenCalledTimes(4);
  });
});

describe('a DORMANT year is closed, not refused for want of a period to stamp', () => {
  it('locks the year and writes no journal when there is nothing to stamp', async () => {
    // The close writes no journal for a year with no posted P&L — it only locks
    // the periods. Refusing it (for want of a journal, or of a period to stamp
    // one with) would leave a company that traded not at all carrying the year
    // open forever.
    const result = await postClosingJournal(COMPANY, USER, '2026', preview([]), null);

    expect(result.entry).toBeNull();
    expect(result.periodsLocked).toBe(1);
    // Only the period lock ran inside the transaction.
    expect(txMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The entry-number RACE — a second closer taking `YE-<year>` between the
 * already-closed lookup and the INSERT — and the typed refusal a squatter
 * earns, moved to tests/unit/services/gl/yearEndCloseRace.test.ts.
 *
 * Those cases drive `closeFiscalYear`, which is now the CONTROLLED operation in
 * `controlledYearEnd` and refuses without an authenticated control transaction.
 * They are driven at that seam there, with the same inputs, the same result
 * shapes and the same refusal names. What stays here is what still lives in the
 * poster itself: its pre-transaction validity guards and the dormant year.
 */
