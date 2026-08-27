/**
 * `allocation_batch_id` must be CLEARED by every path that re-allocates or
 * un-allocates a bank transaction (PR #263 adversarial review).
 *
 * The column says "this row belongs to bulk allocation batch B". It stops being
 * true the moment the row is reversed on its own, or reversed and re-allocated
 * to something else — but nothing clears it automatically. Left set,
 * reverse_bank_allocation_batch(B) walks the stamp and reverses whatever journal
 * is on the row NOW, unwinding a posting batch B never made.
 *
 * `bank_allocation_batch_lines` is the second line of defence (the reverse tool
 * compares the recorded journal id against the current one). This is the first:
 * the stamp itself must not lie. Both exist because the stamp is a column any
 * future write path can forget, while the recorded journal id is a fact.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return { sql: vi.fn(), withTransaction: vi.fn(), fmtDate: actual.fmtDate };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({
  mapTxRow: vi.fn((row: unknown) => row),
}));

import { sql, withTransaction } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import {
  allocateTransaction,
  reverseReconciledTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';

type SqlFn = MockedFunction<(strings: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockWithTx = withTransaction as unknown as MockedFunction<
  (fn: (wTx: unknown) => Promise<void>) => Promise<void>
>;

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const TX = '33333333-3333-3333-3333-333333333333';
const BANK = '44444444-4444-4444-4444-444444444444';
const CONTRA = '55555555-5555-5555-5555-555555555555';

/** Flattened SQL text of every statement issued through a tagged template. */
function textOf(strings: TemplateStringsArray): string {
  return strings.join(' ? ').replace(/\s+/g, ' ');
}

let wtxStatements: string[];

beforeEach(() => {
  vi.clearAllMocks();
  wtxStatements = [];
  mockWithTx.mockImplementation(async (fn) => {
    const wTx = (strings: TemplateStringsArray) => {
      wtxStatements.push(textOf(strings));
      return Promise.resolve([]);
    };
    await fn(wTx);
  });
  vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-new' } as never);
  vi.mocked(postJournalEntry).mockResolvedValue(undefined as never);
});

describe('allocateTransaction', () => {
  it('clears allocation_batch_id — a fresh allocation is not part of the old batch', async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const t = textOf(strings);
      if (t.includes('FROM bank_transactions')) {
        return Promise.resolve([
          { id: TX, amount: -100, bank_account_id: BANK, transaction_date: '2026-08-01', status: 'imported' },
        ]);
      }
      if (t.includes('FROM gl_journal_lines')) return Promise.resolve([{ id: 'jl-1' }]);
      if (t.includes('FROM gl_accounts')) {
        return Promise.resolve([{ account_code: '5000', account_name: 'Expenses' }]);
      }
      return Promise.resolve([]);
    });

    await allocateTransaction(COMPANY, TX, CONTRA, USER);

    const update = wtxStatements.find((s) => s.includes('UPDATE bank_transactions'));
    expect(update).toBeDefined();
    expect(update).toContain('allocation_batch_id = NULL');
  });
});

describe('reverseReconciledTransaction', () => {
  it('clears allocation_batch_id — a reversed line has left its batch', async () => {
    const statements: string[] = [];
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const t = textOf(strings);
      statements.push(t);
      if (t.includes('FROM bank_transactions')) {
        return Promise.resolve([{ id: TX, status: 'allocated', matched_journal_line_id: null }]);
      }
      return Promise.resolve([]);
    });

    await reverseReconciledTransaction(COMPANY, TX, USER);

    const reset = statements.find((s) => s.includes('UPDATE bank_transactions'));
    expect(reset).toBeDefined();
    expect(reset).toContain('allocation_batch_id = NULL');
    // and it still does what it did before — this is an addition, not a rewrite
    expect(reset).toContain("status = 'imported'");
    expect(reset).toContain('matched_journal_line_id = NULL');
  });
});
