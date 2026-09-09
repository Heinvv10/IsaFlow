/**
 * autoMatchTransactions must survive one raced row.
 *
 * Every high-confidence match is applied through `matchTransaction`, which now
 * refuses a row that has been allocated since the candidate query. Letting that
 * refusal escape the loop is worse than it looks: the route catches it and
 * returns 400, but `withAuth` COMMITs on any handler that RETURNS — the commit
 * is gated on the handler throwing, not on the status code. So the matches
 * applied before the raced one persist, the ones after are never attempted, and
 * the user is told the whole run failed. Skip, count, continue.
 *
 * The rows are also locked in id order: matchTransaction holds its row lock to
 * the end of the request, so a run walking rows in a different order from a
 * concurrent allocation deadlocks on the pair.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, matchMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn(() => '') }),
  matchMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', async (importOriginal) => {
  // The REAL BankTransactionAllocatedError: the service narrows with
  // `instanceof`, so a re-declared class here would prove nothing.
  const actual = await importOriginal<
    typeof import('@/modules/accounting/services/bank/bankTransactionQueryService')
  >();
  return { ...actual, matchTransaction: matchMock };
});

import {
  BankTransactionAllocatedError,
  BankMatchTargetError,
} from '@/modules/accounting/services/bank/bankTxStatusMutations';
import { autoMatchTransactions } from '@/modules/accounting/services/bank/bankReconciliationService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const BANK_GL = '22222222-2222-2222-2222-222222222222';
const TX = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('autoMatchTransactions — one raced row must not abort the run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The candidate rows come back in a deliberately jumbled id order (3, 1, 2)
    // so the sort has something to do; every one is an exact-reference match,
    // which scores 1.0 and is therefore applied rather than left a candidate.
    sqlMock
      .mockResolvedValueOnce([
        { id: TX(3), amount: 100, transaction_date: '2026-03-10', reference: 'R3', description: 'R3' },
        { id: TX(1), amount: 100, transaction_date: '2026-03-10', reference: 'R1', description: 'R1' },
        { id: TX(2), amount: 100, transaction_date: '2026-03-10', reference: 'R2', description: 'R2' },
      ] as never)
      .mockResolvedValueOnce([
        { id: 'jl-3', debit: 0, credit: 100, description: 'R3', entry_date: '2026-03-10', entry_number: 'JE-3', source_document_id: null },
        { id: 'jl-1', debit: 0, credit: 100, description: 'R1', entry_date: '2026-03-10', entry_number: 'JE-1', source_document_id: null },
        { id: 'jl-2', debit: 0, credit: 100, description: 'R2', entry_date: '2026-03-10', entry_number: 'JE-2', source_document_id: null },
      ] as never)
      .mockResolvedValue([] as never);
  });

  it('skips the raced row, applies the rest, and reports the skip', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new BankTransactionAllocatedError(txId, 'allocated', 'match');
      return { id: txId };
    });

    const result = await autoMatchTransactions(COMPANY, BANK_GL);

    const attempted = matchMock.mock.calls.map((c) => c[1]);
    expect(attempted).toEqual([TX(1), TX(2), TX(3)]);   // in id order, and all three tried
    expect(result.matched).toBe(2);                      // 1 and 3 landed
    expect(result.skippedRaced).toBe(1);                 // 2 counted, not lost
  });

  it('locks in transaction-id order regardless of query order', async () => {
    matchMock.mockResolvedValue({} as never);

    await autoMatchTransactions(COMPANY, BANK_GL);

    const attempted = matchMock.mock.calls.map((c) => c[1]);
    expect(attempted).toEqual([...attempted].sort());
  });

  // The same race seen from the other side: the peer got there first and the
  // claim check (or `uq_bank_tx_matched_line`) names the line as already bound.
  // The candidate query excludes claimed lines, so this can only be a peer
  // binding it between that read and this write.
  it('skips a LINE_CLAIMED target error the same way', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) {
        throw new BankMatchTargetError('LINE_CLAIMED', `Journal line jl-2 is already matched to bank transaction ${TX(9)}`);
      }
      return { id: txId };
    });

    const result = await autoMatchTransactions(COMPANY, BANK_GL);

    expect(matchMock.mock.calls.map((c) => c[1])).toEqual([TX(1), TX(2), TX(3)]);
    expect(result.matched).toBe(2);
    expect(result.skippedRaced).toBe(1);
  });

  // Adjacent case: the type alone is not the licence to continue. A target the
  // company does not own is a real failure and must still reach the caller.
  it('propagates a LINE_NOT_FOUND target error', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new BankMatchTargetError('LINE_NOT_FOUND', 'Journal line jl-2 not found');
      return { id: txId };
    });

    await expect(autoMatchTransactions(COMPANY, BANK_GL)).rejects.toThrow('not found');
  });

  it('still propagates a failure that is not a race', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new Error('FK violation');
      return { id: txId };
    });

    await expect(autoMatchTransactions(COMPANY, BANK_GL)).rejects.toThrow('FK violation');
  });
});
