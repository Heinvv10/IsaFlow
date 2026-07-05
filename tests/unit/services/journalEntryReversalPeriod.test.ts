/**
 * reverseJournalEntry must derive the reversal's fiscal period from the
 * reversal's OWN entry date (today) — never inherit the original entry's
 * period (P1.1 blind-review HIGH, PR #198).
 *
 * Inheriting meant: original period closed → postJournalEntry throws
 * ClosedFiscalPeriodError and old documents become permanently
 * un-cancellable; original period still open → the reversal lands in a past
 * period its entry_date isn't in (violates the planned P2.2 invariant).
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
    fmtDate: (d: unknown) => String(d),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  getJournalEntryById: vi.fn(),
  createJournalEntry: vi.fn(),
  mapEntryRow: vi.fn(),
}));

import { getJournalEntryById, createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

const mockGet = getJournalEntryById as unknown as MockedFunction<
  (c: string, i: string) => Promise<Record<string, unknown> | null>
>;
const mockCreate = createJournalEntry as unknown as MockedFunction<
  (c: string, input: Record<string, unknown>, u: string, m?: unknown) => Promise<{ id: string }>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const ENTRY_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const OLD_PERIOD = '99999999-0000-4000-8000-999999999999';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

describe('reverseJournalEntry fiscal-period derivation (PR #198 review HIGH)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT inherit the original entry fiscal period — lets createJournalEntry derive from today', async () => {
    mockGet.mockResolvedValue({
      id: ENTRY_ID,
      entryNumber: 'JE-2025-00001',
      status: 'posted',
      source: 'auto_invoice',
      fiscalPeriodId: OLD_PERIOD,
      lines: [
        { glAccountId: 'a1', debit: 100, credit: 0, description: 'x' },
        { glAccountId: 'a2', debit: 0, credit: 100, description: 'y' },
      ],
    });
    mockCreate.mockResolvedValue({ id: 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb' });

    // postJournalEntry (same module, unmockable) will fail after createJournalEntry
    // because getJournalEntryById returns our posted fixture for the reversal id
    // too — that's fine, the assertion below only concerns createJournalEntry's input.
    await reverseJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID).catch(() => undefined);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const input = mockCreate.mock.calls[0]![1];
    expect(input.fiscalPeriodId, 'reversal must not inherit the original period').toBeUndefined();
    // Dr/Cr swapped
    const lines = input.lines as Array<{ glAccountId: string; debit: number; credit: number }>;
    expect(lines[0]).toMatchObject({ glAccountId: 'a1', debit: 0, credit: 100 });
    expect(lines[1]).toMatchObject({ glAccountId: 'a2', debit: 100, credit: 0 });
  });
});
