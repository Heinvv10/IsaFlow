/**
 * postJournalEntry must throw ClosedFiscalPeriodError — the TYPE, not just a
 * message — when the target period is not open.
 *
 * FOUR consumers narrow on that class to decide whether a failure is
 * recoverable or fatal:
 *
 *   capture/[id]/post-expense.ts        swallow → leave the journal a draft
 *   bankRulesMatchingService.ts         delete the draft, count the skip, continue
 *   closeRunService.ts                  same pattern
 *   customer-invoices-detail.ts:211     map to a 400 instead of a 500
 *
 * Replacing the real `throw new ClosedFiscalPeriodError(status)` in
 * journalEntryPostingService with a plain `throw new Error(...)` left the entire
 * 5137-test suite green while silently converting every one of them from
 * "handle gracefully" to "propagate". Every test that involved the class
 * constructed it in its own mock and fed it to the consumer, so the `instanceof`
 * checks were self-consistent by construction and none of them noticed.
 *
 * SCOPE: this file pins the THROW — that postJournalEntry raises the class, not
 * merely a message. It does NOT pin that each consumer still narrows on it; a
 * consumer's `instanceof` block can be deleted without failing anything here.
 * That needs a test per consumer, and they exist:
 *   closeRunService.test.ts:160, postExpenseZeroVatLine.test.ts, and
 *   bankRulesClosedPeriod.test.ts (added because that one was unprotected —
 *   deleting its narrowing left the full suite green).
 *   customer-invoices-detail is covered by customerInvoiceDetailAction.test.ts,
 *   which deliberately imports the real class for exactly this reason.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  getJournalEntryById: vi.fn(),
  createJournalEntry: vi.fn(),
  resolveUserUuid: vi.fn(async (u: string) => u),
  mapEntryRow: vi.fn((r: unknown) => r),
}));

import { sql } from '@/lib/neon';
import { getJournalEntryById } from '@/modules/accounting/services/gl/journalEntryCrudService';
import {
  postJournalEntry,
  ClosedFiscalPeriodError,
} from '@/modules/accounting/services/gl/journalEntryPostingService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const ENTRY = '33333333-3333-3333-3333-333333333333';

const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const getMock = getJournalEntryById as unknown as MockedFunction<
  (...a: unknown[]) => Promise<unknown>
>;

/** A balanced draft entry sitting in a period with the given status. */
function withEntryInPeriod(periodStatus: string) {
  getMock.mockResolvedValue({
    id: ENTRY,
    status: 'draft',
    fiscalPeriodId: 'fp-1',
    entryNumber: 'JE-2026-00001',
    lines: [
      { glAccountId: 'acct-a', debit: 100, credit: 0 },
      { glAccountId: 'acct-b', debit: 0, credit: 100 },
    ],
  });
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM fiscal_periods')) return Promise.resolve([{ status: periodStatus }]);
    return Promise.resolve([{ id: ENTRY, entry_number: 'JE-2026-00001', status: 'posted' }]);
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('postJournalEntry — closed-period contract', () => {
  it('throws ClosedFiscalPeriodError (the class) for a closed period', async () => {
    withEntryInPeriod('closed');

    // toBeInstanceOf, NOT a message match: the consumers narrow on the type, so
    // a plain Error carrying the same text would satisfy a message assertion
    // while breaking all three of them.
    await expect(postJournalEntry(COMPANY, ENTRY, USER))
      .rejects.toBeInstanceOf(ClosedFiscalPeriodError);
  });

  it('throws it for a locked period too, not only "closed"', async () => {
    withEntryInPeriod('locked');

    await expect(postJournalEntry(COMPANY, ENTRY, USER))
      .rejects.toBeInstanceOf(ClosedFiscalPeriodError);
  });

  it('carries the period status so callers can report which state blocked them', async () => {
    withEntryInPeriod('closed');

    await expect(postJournalEntry(COMPANY, ENTRY, USER)).rejects.toMatchObject({
      name: 'ClosedFiscalPeriodError',
      periodStatus: 'closed',
    });
  });

  it('does NOT throw it when the period is open', async () => {
    withEntryInPeriod('open');

    await expect(postJournalEntry(COMPANY, ENTRY, USER)).resolves.toBeDefined();
  });

  it('an unbalanced entry fails with a DIFFERENT error — the class is period-specific', async () => {
    // Guards against "make everything a ClosedFiscalPeriodError" satisfying the
    // tests above: consumers swallow this class, so widening it would convert a
    // genuine imbalance into a silently-tolerated draft.
    getMock.mockResolvedValue({
      id: ENTRY,
      status: 'draft',
      fiscalPeriodId: 'fp-1',
      lines: [
        { glAccountId: 'acct-a', debit: 100, credit: 0 },
        { glAccountId: 'acct-b', debit: 0, credit: 60 },
      ],
    });
    sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('') : String(strings);
      if (text.includes('FROM fiscal_periods')) return Promise.resolve([{ status: 'open' }]);
      return Promise.resolve([{ id: ENTRY, entry_number: 'JE-1', status: 'posted' }]);
    }) as never);

    const err = await postJournalEntry(COMPANY, ENTRY, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ClosedFiscalPeriodError);
  });
});
