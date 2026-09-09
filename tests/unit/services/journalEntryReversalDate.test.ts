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
  // reverseJournalEntry claims the reversal with a predicated UPDATE before it
  // creates the contra; one row back means this caller won it. Everything else
  // this suite exercises is indifferent to the rows returned.
  const sqlMock = Object.assign(
    vi.fn((strings: readonly string[]) =>
      Promise.resolve(strings.join(' ').includes('reversed_at IS NULL') ? [{ id: 'claimed' }] : [])),
    {
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

vi.mock('@/lib/alsTransaction', async () => {
  const { als } = await import('@/lib/als');
  return {
    // reverseJournalEntry wraps itself in a transaction (withAlsTransaction) so
    // the reversal claim cannot outlive the contra, and the claim REFUSES to run
    // without one. Bind a client whose BEGIN/COMMIT and lock_timeout statements
    // are no-ops, so this suite keeps asserting reversal semantics.
    withAlsTransaction: (userId: string, companyId: string | undefined, fn: () => Promise<unknown>) =>
      als.run(
        {
          client: { query: async () => ({ rows: [{ v: '0' }] }) } as never,
          userId,
          companyId,
          claims: {},
        },
        fn,
      ),
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
    mockSql.mockImplementation((strings: readonly string[]) =>
      Promise.resolve(strings.join(' ').includes('reversed_at IS NULL') ? [{ id: 'claimed' }] : []));
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

  it('releases the reversal claim when the draft it created was actually deleted', async () => {
    // The claim is taken BEFORE the contra exists (K-010), so `reversed_at` is
    // written on the way in. The invariant is not "never written" — it is that a
    // failed post leaves the original UNMARKED and UNLINKED. The DELETE below is
    // made to report one row removed, which is the case where the contra is
    // genuinely gone and the claim must go with it.
    mockSql.mockImplementation((strings: readonly string[]) => {
      const text = strings.join(' ');
      if (text.includes('reversed_at IS NULL')) return Promise.resolve([{ id: 'claimed' }]);
      if (/DELETE\s+FROM\s+gl_journal_entries/i.test(text)) return Promise.resolve([{ id: REVERSAL_ID }]);
      return Promise.resolve([]);
    });

    await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID).catch(() => undefined);
    const text = issuedSql().join(' | ');
    expect(text).not.toMatch(/reversal_of_id/i);
    const release = issuedSql().find((t) => /reversed_at\s*=\s*NULL/i.test(t));
    expect(release, 'a failed post must release the reversal claim').toBeDefined();
    expect(release!).toMatch(/reversed_by\s*=\s*NULL/i);
    expect(release!).toMatch(/company_id/i);
  });

  it('KEEPS the claim when the contra was not a draft and so survived the delete', async () => {
    // postJournalEntry can throw after its status UPDATE has landed. The
    // `status = 'draft'` guard then matches nothing and a POSTED contra
    // survives, unlinked — invisible to the unique index. Clearing reversed_at
    // there would invite a retry that posts a second one, so the claim stays:
    // a posted contra exists, so the original really is reversed.
    await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID).catch(() => undefined);
    const text = issuedSql().join(' | ');
    expect(text).not.toMatch(/reversal_of_id/i);
    expect(issuedSql().find((t) => /reversed_at\s*=\s*NULL/i.test(t))).toBeUndefined();
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
 * Three guards:
 *   - the date must parse as YYYY-MM-DD, because it is interpolated into a DATE
 *     column and a malformed value raises 22P02, which the caller reads as a
 *     generic failure;
 *   - it must not PRECEDE the original entry. A correction that lands before
 *     the thing it corrects is nonsense in every period-bounded report — the
 *     contra shows up before the entry it undoes;
 *   - its period must exist AND be open.
 *
 * That last one was initially left to postJournalEntry, on the reasoning that a
 * second check could only drift from the one governing the write. An adversarial
 * review proved that reasoning wrong: postJournalEntry guards its closed-period
 * check behind `if (entry.fiscalPeriodId)`, and createJournalEntry leaves that
 * NULL when NO period covers the date. A date like `9999-12-31` — a real
 * calendar day in a fiscal year nobody has created — therefore posted silently,
 * outside every period-bounded report. It is checked here now.
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

  it('uses the caller date even when the ORIGINAL period is closed', async () => {
    // The whole point of asking: the closed-period fallback to today is what
    // the caller is overriding. Only the TARGET date's period is consulted, so
    // the original being closed is irrelevant once a date is given.
    mockPeriodStatus.mockResolvedValue('open'); // status of the TARGET date
    expect(await reversalEntryDate({ reversalDate: '2026-07-15' })).toBe('2026-07-15');
  });

  it('checks the TARGET period, not the original, when told the date', async () => {
    // The original's status drives only the default. What matters for an
    // explicit date is whether the date the caller CHOSE can be posted on.
    mockPeriodStatus.mockResolvedValue('open');
    await reversalEntryDate({ reversalDate: '2026-07-15' });
    expect(mockPeriodStatus).toHaveBeenCalledWith(COMPANY_ID, '2026-07-15');
    expect(mockPeriodStatus).not.toHaveBeenCalledWith(COMPANY_ID, ORIGINAL_DATE);
  });

  it('REFUSES a date no fiscal period covers, writing nothing', async () => {
    // The gap an adversarial review found, and the reason this check cannot be
    // left to postJournalEntry: createJournalEntry leaves fiscal_period_id NULL
    // when no period covers the date, and postJournalEntry guards its
    // closed-period check behind `if (entry.fiscalPeriodId)`. A NULL period
    // therefore skips that check entirely, and the contra posts SILENTLY,
    // permanently outside every period-bounded report — trial balance, VAT201,
    // AFS. `9999-12-31` is a real calendar day, so the format check passes it.
    mockPeriodStatus.mockResolvedValue('no_period');
    await expect(
      reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID, { reversalDate: '9999-12-31' }),
    ).rejects.toThrow(/no fiscal period/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('REFUSES a date whose period is closed, writing nothing', async () => {
    // postJournalEntry would also refuse this one, but only after
    // createJournalEntry has INSERTed a draft. Refusing up front means there is
    // no draft to clean up, and the caller gets the reason rather than a
    // generic post failure.
    mockPeriodStatus.mockResolvedValue('closed');
    await expect(
      reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID, { reversalDate: '2026-07-15' }),
    ).rejects.toThrow(/closed/i);
    expect(mockCreate).not.toHaveBeenCalled();
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
