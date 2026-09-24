/**
 * R-012 — the DEFAULT reversal date never precedes a future-dated original.
 *
 * resolveReversalDate's default arm falls back to TODAY when the original's
 * period is not open. For a FUTURE-dated original that put the contra first,
 * which breaks the as-at parity ageing and statements read
 * (softDeleteLedgerPresence). Split from journalEntryReversalDate.test.ts
 * (over the 300-line cap), whose mock scaffold this reuses.
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
    withAlsTransaction: (
      actor: { userId: string; companyId: string | undefined },
      fn: () => Promise<unknown>,
    ) =>
      als.run(
        {
          client: { query: async () => ({ rows: [{ v: '0' }] }) } as never,
          userId: actor.userId,
          companyId: actor.companyId,
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

const { autoCreatableMock } = vi.hoisted(() => ({ autoCreatableMock: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryReversalVatRoll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/journalEntryReversalVatRoll')>()),
  isDateAutoCreatable: autoCreatableMock,
}));

import { sql } from '@/lib/neon';
import { getJournalEntryById, createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { ReversalBeforeOriginalError } from '@/modules/accounting/services/gl/journalEntryReversalDate';

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

const ymd = (offset: number): string => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('R-012: the default reversal date and a future-dated original', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ id: REVERSAL_ID });
  });

  it('REFUSES, writing nothing, when the original\'s period is CLOSED — without consulting auto-create', async () => {
    mockGet.mockResolvedValue(postedEntry(ymd(40)));
    mockPeriodStatus.mockResolvedValue('closed');
    const err = await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReversalBeforeOriginalError);
    // IS-A ClosedFiscalPeriodError: every route mapping a closed period to 400 maps this.
    expect(err).toBeInstanceOf(ClosedFiscalPeriodError);
    expect((err as Error).message).toContain(ymd(40));
    expect(autoCreatableMock).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('dates the contra WITH the original when it has no period and posting would create its year', async () => {
    mockGet.mockResolvedValue(postedEntry(ymd(40)));
    mockPeriodStatus.mockResolvedValue('no_period');
    autoCreatableMock.mockResolvedValue(true);
    expect(await reversalEntryDate()).toBe(ymd(40));
  });

  it('keeps TODAY for a typo\'d year outside the auto-create window, so it stays reversible', async () => {
    mockGet.mockResolvedValue(postedEntry('9999-12-31'));
    mockPeriodStatus.mockResolvedValue('no_period');
    autoCreatableMock.mockResolvedValue(false);
    expect(await reversalEntryDate()).toBe(ymd(0));
  });

  it('still falls back to today when the original is dated today and its period is closed', async () => {
    mockGet.mockResolvedValue(postedEntry(ymd(0)));
    mockPeriodStatus.mockResolvedValue('closed');
    expect(await reversalEntryDate()).toBe(ymd(0));
  });
});
