/**
 * reverseReconciledTransaction must be able to attribute its contra journal.
 *
 * The MCP safety model is attribution + review, not per-action confirmation:
 * agent work is found via posting_agent LIKE 'mcp:%' and corrected as a set.
 * A reversal posts a REAL journal, so if that contra is stamped human:<userId>
 * the agent's own correction escapes the review surface — the corrective
 * mechanism is the one operation that must not be invisible.
 *
 * Backward compatibility is asserted explicitly: every existing non-MCP caller
 * (REST bank-transactions-action, autoPostUndoService) passes no opts and must
 * keep landing on defaultHumanMeta inside reverseJournalEntry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
    fmtDate: vi.fn(() => '2026-08-04'),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({
  mapTxRow: vi.fn((r: unknown) => r),
}));
vi.mock('@/modules/accounting/services/capture/fourWayMatchService', () => ({
  recordPaymentMatch: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const TX_ID = '22222222-2222-2222-2222-222222222222';
const LINE_ID = '33333333-3333-3333-3333-333333333333';
const JE_ID = '44444444-4444-4444-4444-444444444444';
const USER_ID = '55555555-5555-5555-5555-555555555555';

/** SELECT tx → SELECT journal_entry_id for the matched line → UPDATE reset. */
function primeReversal(): void {
  vi.mocked(sql)
    .mockResolvedValueOnce([
      { id: TX_ID, status: 'allocated', matched_journal_line_id: LINE_ID },
    ] as never)
    .mockResolvedValueOnce([{ journal_entry_id: JE_ID }] as never)
    .mockResolvedValueOnce([] as never);
}

beforeEach(() => vi.clearAllMocks());

describe('reverseReconciledTransaction — posting-agent attribution', () => {
  it('forwards the caller posting agent to the contra journal', async () => {
    primeReversal();

    await reverseReconciledTransaction(COMPANY_ID, TX_ID, USER_ID, {
      postingAgent: 'mcp:reverse_bank_allocation:v1',
    });

    expect(reverseJournalEntry).toHaveBeenCalledWith(COMPANY_ID, JE_ID, USER_ID, {
      postingAgent: 'mcp:reverse_bank_allocation:v1',
    });
  });

  it('passes no posting agent when the caller supplies none, so the contra stays human', async () => {
    primeReversal();

    await reverseReconciledTransaction(COMPANY_ID, TX_ID, USER_ID);

    const call = vi.mocked(reverseJournalEntry).mock.calls[0]!;
    expect(call[0]).toBe(COMPANY_ID);
    expect(call[1]).toBe(JE_ID);
    expect(call[2]).toBe(USER_ID);
    expect(call[3]?.postingAgent).toBeUndefined();
  });

  it('still resets the bank transaction scoped to the tenant', async () => {
    primeReversal();

    await reverseReconciledTransaction(COMPANY_ID, TX_ID, USER_ID, {
      postingAgent: 'mcp:reverse_bank_allocation:v1',
    });

    const update = vi.mocked(sql).mock.calls.find((c) =>
      (c[0] as unknown as readonly string[]).join(' ').includes('UPDATE bank_transactions'),
    );
    expect(update).toBeDefined();
    expect(update!.slice(1)).toContain(COMPANY_ID);
  });
});
