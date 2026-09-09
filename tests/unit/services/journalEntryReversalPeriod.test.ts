/**
 * reverseJournalEntry must derive the reversal's fiscal period from the
 * reversal's OWN entry date — never inherit the original entry's period id
 * (P1.1 blind-review HIGH, PR #198).
 *
 * Inheriting the period id meant the reversal could land in a period its
 * entry_date isn't in, and a closed original period made old documents
 * permanently un-cancellable (postJournalEntry throws ClosedFiscalPeriodError).
 *
 * This invariant is about the period ID only. WHICH date the reversal carries
 * is a separate rule — original date when its period is open, else today —
 * pinned in journalEntryReversalDate.test.ts.
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
    // reverseJournalEntry wraps itself in a transaction (withReversalTransaction)
    // so the reversal claim cannot outlive the contra. Outside a request it
    // opens one on a pool client and binds it into ALS, so this suite hands it
    // a client whose BEGIN/COMMIT and lock_timeout statements are no-ops.
    getPool: () => ({
      connect: async () => ({
        query: async () => ({ rows: [{ v: '0' }] }),
        release: () => undefined,
      }),
    }),
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
