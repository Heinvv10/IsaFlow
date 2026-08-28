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

import { getJournalEntryById, createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

const mockGet = getJournalEntryById as unknown as MockedFunction<
  (c: string, i: string) => Promise<Record<string, unknown> | null>
>;
const mockCreate = createJournalEntry as unknown as MockedFunction<
  (c: string, input: Record<string, unknown>, u: string, m?: unknown) => Promise<{ id: string }>
>;
const mockPeriodStatus = getPeriodStatusForDate as unknown as MockedFunction<
  (c: string, d: string | Date) => Promise<'open' | 'closed' | 'no_period'>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const ENTRY_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

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
async function reversalEntryDate(): Promise<string> {
  // postJournalEntry runs after createJournalEntry and is in the same module,
  // so it cannot be mocked; it throws on our fixture. The assertion only
  // concerns what createJournalEntry was called with.
  await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID).catch(() => undefined);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  return mockCreate.mock.calls[0]![1].entryDate as string;
}

describe('reverseJournalEntry — reversal entry date', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(postedEntry(ORIGINAL_DATE));
    mockCreate.mockResolvedValue({ id: 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb' });
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
