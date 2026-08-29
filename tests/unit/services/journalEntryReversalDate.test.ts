/**
 * A reversal is dated to the ORIGINAL entry's date when that period is still
 * open, and only falls back to today when it is not.
 *
 * Why: dating every reversal to today moved the correction into a later period
 * than the entry it undoes. The pair then no longer nets to zero in any
 * period-bounded report, and when it straddles a VAT period the return for the
 * original period stays overstated while the next one is understated — a
 * correction that silently misstates two returns instead of fixing one.
 *
 * The fallback still matters: a closed original period must not make old
 * documents permanently un-cancellable (postJournalEntry would throw
 * ClosedFiscalPeriodError), which is what the old unconditional-today rule was
 * really protecting.
 *
 * Companion to journalEntryReversalPeriod.test.ts, which pins the separate
 * invariant that the reversal never INHERITS the original's fiscalPeriodId.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    // The real fmtDate: local calendar getters, strings passed through.
    fmtDate: (val: unknown) => {
      if (!val) return '';
      if (val instanceof Date) {
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      const s = String(val);
      return s.includes('T') ? s.split('T')[0]! : s;
    },
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  getJournalEntryById: vi.fn(),
  createJournalEntry: vi.fn(),
  resolveUserUuid: vi.fn(async (u: string) => u),
  mapEntryRow: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { getJournalEntryById, createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

const mockGet = getJournalEntryById as unknown as MockedFunction<
  (c: string, i: string) => Promise<Record<string, unknown> | null>
>;
const mockCreate = createJournalEntry as unknown as MockedFunction<
  (c: string, input: Record<string, unknown>, u: string, m?: unknown) => Promise<{ id: string }>
>;
const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const mockPeriodStatus = getPeriodStatusForDate as unknown as MockedFunction<
  (c: string, d: string | Date) => Promise<'open' | 'closed' | 'no_period'>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const ENTRY_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';
const REVERSAL_ID = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

/** Last day of a VAT period — the case where a day's drift changes the return. */
const ORIGINAL_DATE = '2026-06-30';

function postedEntry(entryDate: string) {
  return {
    id: ENTRY_ID,
    entryNumber: 'JE-2026-00001',
    status: 'posted',
    source: 'auto_invoice',
    entryDate,
    lines: [
      { glAccountId: 'a1', debit: 100, credit: 0, description: 'x' },
      { glAccountId: 'a2', debit: 0, credit: 100, description: 'y' },
    ],
  };
}

/** The entryDate handed to createJournalEntry, whatever happened afterwards. */
async function reversalEntryDate(opts?: { reversalDate?: string }): Promise<string> {
  // postJournalEntry runs after createJournalEntry and is in the same module,
  // so it cannot be mocked; it throws on our fixture. The assertion only
  // concerns what createJournalEntry was called with.
  await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID, opts).catch(() => undefined);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  return mockCreate.mock.calls[0]![1].entryDate as string;
}

describe('reverseJournalEntry — reversal entry date', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(postedEntry(ORIGINAL_DATE));
    mockCreate.mockResolvedValue({ id: REVERSAL_ID });
  });

  it('dates the reversal to the original entry date when that period is open', async () => {
    mockPeriodStatus.mockResolvedValue('open');
    expect(await reversalEntryDate()).toBe(ORIGINAL_DATE);
  });

  it('checks the period of the ORIGINAL date, not of today', async () => {
    mockPeriodStatus.mockResolvedValue('open');
    await reversalEntryDate();
    expect(mockPeriodStatus).toHaveBeenCalledWith(COMPANY_ID, ORIGINAL_DATE);
  });

  it('falls back to today when the original period is closed', async () => {
    mockPeriodStatus.mockResolvedValue('closed');
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(await reversalEntryDate()).toBe(expected);
  });

  it('falls back to today when no fiscal period covers the original date', async () => {
    mockPeriodStatus.mockResolvedValue('no_period');
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(await reversalEntryDate()).toBe(expected);
  });

  it('handles an original entryDate that arrives as a Date at local midnight', async () => {
    // What pg's default DATE parser used to hand back. fmtDate must not shift it.
    mockGet.mockResolvedValue(postedEntry(new Date(2026, 5, 30, 0, 0, 0) as unknown as string));
    mockPeriodStatus.mockResolvedValue('open');
    expect(await reversalEntryDate()).toBe('2026-06-30');
  });

  it('never inherits the original fiscal period id', async () => {
    mockPeriodStatus.mockResolvedValue('open');
    await reversalEntryDate();
    expect(mockCreate.mock.calls[0]![1].fiscalPeriodId).toBeUndefined();
  });
});

/**
 * createJournalEntry INSERTs a draft before postJournalEntry runs. If the post
 * fails — the fiscal period flipping closed between the period read and the
 * post is the realistic race — that draft must not be left behind: it would sit
 * in the GL unposted and unlinked, with the original entry still not marked
 * reversed. A blind adversarial review found this dangling-draft path; the
 * `AND status = 'draft'` guard is what makes the cleanup incapable of touching
 * a posted entry.
 */
describe('reverseJournalEntry — failed post must not leave a dangling draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(postedEntry(ORIGINAL_DATE));
    mockCreate.mockResolvedValue({ id: REVERSAL_ID });
    mockPeriodStatus.mockResolvedValue('open');
    mockSql.mockResolvedValue([]);
  });

  /** All SQL text issued during the call, one string per sql`` invocation. */
  function issuedSql(): string[] {
    return mockSql.mock.calls.map((c) => (c[0] as readonly string[]).join(' '));
  }

  it('deletes the draft reversal and re-throws when posting fails', async () => {
    // postJournalEntry is in the same module and cannot be mocked. It reloads
    // the reversal by id via getJournalEntryById, which returns our POSTED
    // fixture — so it throws "Cannot post entry with status: posted", standing
    // in for any post-time failure.
    await expect(reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID)).rejects.toThrow();

    const del = issuedSql().find((t) => /DELETE\s+FROM\s+gl_journal_entries/i.test(t));
    expect(del, 'a failed post must delete the draft it created').toBeDefined();
    // The guard that makes this safe.
    expect(del!).toMatch(/status\s*=\s*'draft'/i);
    // Scoped to the tenant and to the row we just created.
    expect(del!).toMatch(/company_id/i);
  });

  it('never issues the reversed_at / reversal_of_id link-backs when posting fails', async () => {
    await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID).catch(() => undefined);
    const text = issuedSql().join(' | ');
    expect(text).not.toMatch(/reversed_at/i);
    expect(text).not.toMatch(/reversal_of_id/i);
  });
});

/**
 * An explicit reversal_date, chosen by the caller.
 *
 * The default above answers "which date SHOULD a reversal carry" — but it is
 * still a default, and a caller correcting last month's books in this month's
 * open period has a legitimate reason to say so. Until this existed there was
 * no way to express that: the date was an internal local variable with no
 * parameter on any surface, and no tool description said which date a contra
 * would land on.
 *
 * Two guards, and only two. The rest is deliberately left to the machinery that
 * already enforces it:
 *   - the date must parse as YYYY-MM-DD, because it is interpolated into a DATE
 *     column and a malformed value raises 22P02, which the caller reads as a
 *     generic failure;
 *   - it must not PRECEDE the original entry. A correction that lands before
 *     the thing it corrects is nonsense in every period-bounded report — the
 *     contra shows up before the entry it undoes.
 * A closed target period is NOT re-checked here: createJournalEntry derives the
 * fiscal period from the date and postJournalEntry raises ClosedFiscalPeriodError,
 * so duplicating that check would only let the two answers drift.
 */
describe('reverseJournalEntry — an explicit reversal date', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(postedEntry(ORIGINAL_DATE));
    mockCreate.mockResolvedValue({ id: REVERSAL_ID });
  });

  it('uses the caller date instead of the default when one is given', async () => {
    mockPeriodStatus.mockResolvedValue('open');
    expect(await reversalEntryDate({ reversalDate: '2026-07-15' })).toBe('2026-07-15');
  });

  it('uses the caller date even when the original period is CLOSED', async () => {
    // The whole point of asking: the closed-period fallback to today is what the
    // caller is overriding. Whether the TARGET period is open is decided by
    // postJournalEntry, not here.
    mockPeriodStatus.mockResolvedValue('closed');
    expect(await reversalEntryDate({ reversalDate: '2026-07-15' })).toBe('2026-07-15');
  });

  it('does not even ask for the original period status when told the date', async () => {
    // The default is the only reason that lookup exists; asking anyway would be
    // a wasted query on every explicit reversal.
    mockPeriodStatus.mockResolvedValue('open');
    await reversalEntryDate({ reversalDate: '2026-07-15' });
    expect(mockPeriodStatus).not.toHaveBeenCalled();
  });

  it('accepts a date equal to the original entry date', async () => {
    mockPeriodStatus.mockResolvedValue('open');
    expect(await reversalEntryDate({ reversalDate: ORIGINAL_DATE })).toBe(ORIGINAL_DATE);
  });

  it('REFUSES a date before the original entry, writing nothing', async () => {
    mockPeriodStatus.mockResolvedValue('open');
    await expect(
      reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID, { reversalDate: '2026-06-29' }),
    ).rejects.toThrow(/before the entry it reverses/i);
    // Refused BEFORE the draft is created — nothing to unwind.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('REFUSES a malformed date, writing nothing', async () => {
    mockPeriodStatus.mockResolvedValue('open');
    for (const bad of ['15/07/2026', '2026-7-5', 'today', '', '2026-13-01', '2026-02-30']) {
      vi.clearAllMocks();
      mockGet.mockResolvedValue(postedEntry(ORIGINAL_DATE));
      mockCreate.mockResolvedValue({ id: REVERSAL_ID });
      await expect(
        reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID, { reversalDate: bad }),
      ).rejects.toThrow(/YYYY-MM-DD/);
      expect(mockCreate, bad).not.toHaveBeenCalled();
    }
  });

  it('still applies the default when reversalDate is undefined', async () => {
    // Every one of the ten existing callers passes no date at all; none of them
    // may change behaviour.
    mockPeriodStatus.mockResolvedValue('open');
    expect(await reversalEntryDate({})).toBe(ORIGINAL_DATE);
    expect(mockPeriodStatus).toHaveBeenCalledWith(COMPANY_ID, ORIGINAL_DATE);
  });
});
