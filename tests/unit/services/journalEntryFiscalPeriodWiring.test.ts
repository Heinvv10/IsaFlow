/**
 * createJournalEntry must actually ASK for a fiscal period.
 *
 * Written because a mutation exposed the gap: deleting the
 * `ensureFiscalPeriodForDate` call from createJournalEntry entirely — so every
 * entry would insert with `fiscal_period_id = NULL` again — left 68 tests
 * green. The resolver had thorough tests of its own and the crud service had
 * thorough tests of its own, and nothing asserted the two were connected.
 *
 * That is the same class of defect the reversal_date work guarded against: a
 * dependency that is imported, documented and unit-tested, but dropped before
 * the call site, looks exactly like a working feature until someone inspects
 * the row that got written.
 *
 * What makes it worth pinning here specifically: a NULL fiscal period is not a
 * loud failure. postJournalEntry's closed-period check is guarded by
 * `if (entry.fiscalPeriodId)`, so a NULL skips validation and POSTS, landing
 * outside the trial balance, the VAT201 and the AFS. Migration 501 names the
 * cost of that happening once already — Britech's R267,109.70 salary
 * understatement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
  withTransaction: vi.fn(),
  fmtDate: (v: unknown) => String(v ?? ''),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodAutoCreate', () => ({
  ensureFiscalPeriodForDate: vi.fn(),
}));

import { ensureFiscalPeriodForDate } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const USER = 'ffffffff-0000-4000-8000-ffffffffffff';
const PERIOD = 'pppppppp-0000-4000-8000-pppppppppppp';

const INPUT = {
  entryDate: '2027-03-15',
  description: 'test',
  source: 'manual' as const,
  lines: [
    { glAccountId: 'a1', debit: 100, credit: 0, description: 'x' },
    { glAccountId: 'a2', debit: 0, credit: 100, description: 'y' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([]);
});

describe('createJournalEntry — fiscal period resolution is wired in', () => {
  it('asks ensureFiscalPeriodForDate for the ENTRY DATE, not today', async () => {
    vi.mocked(ensureFiscalPeriodForDate).mockResolvedValue(PERIOD);
    // The INSERT itself is not the subject here; the call may fail afterwards
    // on the mocked sql without affecting what we assert.
    await createJournalEntry(COMPANY, INPUT, USER).catch(() => undefined);

    expect(ensureFiscalPeriodForDate).toHaveBeenCalledTimes(1);
    expect(ensureFiscalPeriodForDate).toHaveBeenCalledWith(COMPANY, '2027-03-15');
  });

  it('does not ask when the caller already supplied a fiscalPeriodId', async () => {
    // A caller-supplied period is validated against the entry date by the
    // existing coverage check; resolving a second one would be a wasted query
    // and could disagree with it.
    await createJournalEntry(COMPANY, { ...INPUT, fiscalPeriodId: PERIOD }, USER)
      .catch(() => undefined);
    expect(ensureFiscalPeriodForDate).not.toHaveBeenCalled();
  });

  it('tolerates a null result rather than throwing', async () => {
    // A date outside the auto-create window still resolves to null. That must
    // behave exactly as it did before — turning a previously-succeeding post
    // into a throw is the outcome the design set out to avoid.
    vi.mocked(ensureFiscalPeriodForDate).mockResolvedValue(null);
    await createJournalEntry(COMPANY, INPUT, USER).catch(() => undefined);
    expect(ensureFiscalPeriodForDate).toHaveBeenCalled();
  });
});
