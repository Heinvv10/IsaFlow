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

const { sqlMock, matchMock, sp } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn(() => '') }),
  matchMock: vi.fn(),
  // Records savepoint use: which names were opened, how many are open now, and how many rolled back (the callback threw).
  sp: { names: [] as string[], open: 0, rolledBack: 0 },
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d),
  withSavepoint: async (name: string, fn: () => Promise<unknown>) => {
    sp.names.push(name); sp.open++;
    try { return await fn(); } catch (e) { sp.rolledBack++; throw e; } finally { sp.open--; }
  },
}));
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

import { BankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import {
  BankTransactionAllocatedError,
  BankMatchTargetError,
} from '@/modules/accounting/services/bank/bankTxStatusMutations';
import {
  BankTransactionLockTimeoutError, BankMatchUnavailableError,
} from '@/modules/accounting/services/bank/bankTxLock';
import { autoMatchTransactions } from '@/modules/accounting/services/bank/bankReconciliationService';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const BANK_GL = '22222222-2222-2222-2222-222222222222';
const TX = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * The candidate rows come back in a deliberately jumbled id order (3, 1, 2)
 * so the sort has something to do; every one is an exact-reference match,
 * which scores 1.0 and is therefore applied rather than left a candidate.
 */
function queueCandidates(): void {
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
}

describe('autoMatchTransactions — one raced row must not abort the run', () => {
  beforeEach(() => {
    sp.names.length = 0; sp.open = 0; sp.rolledBack = 0;
    vi.clearAllMocks();
    queueCandidates();
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

  // The third face of the same race. `uq_bank_tx_matched_line` (migration 657)
  // makes two racers block on the INDEX where they previously never contended,
  // and that wait is bounded by lockBankTransactionForUpdate's 5s lock_timeout
  // — so a slow peer surfaces as a lock timeout rather than a 23505. Escaping,
  // it would abort the run with the earlier matches COMMITted by withAuth's 4xx.
  it('skips a lock timeout the same way', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new BankTransactionLockTimeoutError(txId);
      return { id: txId };
    });

    const result = await autoMatchTransactions(COMPANY, BANK_GL);

    expect(matchMock.mock.calls.map((c) => c[1])).toEqual([TX(1), TX(2), TX(3)]);
    expect(result.matched).toBe(2);
    expect(result.skippedRaced).toBe(1);
  });

  // D11 round 4: a deadlock victim is a held row too (skipped, the rest apply); if EVERY attempted candidate was held
  // nothing committed, so the first held error is re-thrown for the route's 503.
  it('skips a raw 40P01 deadlock victim like a lock timeout', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return { id: txId };
    });
    const result = await autoMatchTransactions(COMPANY, BANK_GL);
    expect(result.matched).toBe(2);
    expect(result.skippedRaced).toBe(1);
  });

  it('runs each candidate inside its own savepoint, which is rolled back for the held one', async () => {
    const insideSavepoint: boolean[] = [];
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      insideSavepoint.push(sp.open > 0);
      if (txId === TX(1)) throw new BankTransactionLockTimeoutError(txId);
      return { id: txId };
    });
    const result = await autoMatchTransactions(COMPANY, BANK_GL);
    expect(insideSavepoint, 'every matchTransaction ran inside a savepoint').toEqual([true, true, true]);
    expect(sp.names.filter((n) => n === 'auto_match_row')).toHaveLength(3);
    expect(sp.names[0]).toBe('auto_match_run');
    expect(sp.rolledBack, 'only the held candidate rolled back').toBe(1);
    expect(result.matched).toBe(2);
    expect(result.skippedRaced).toBe(1);
  });

  it('skips D10\'s provisional-line refusal (a typed BankAllocationRefusal) for one candidate', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new BankAllocationRefusal('This bank line is booked by provisional journal JE-1');
      return { id: txId };
    });
    const result = await autoMatchTransactions(COMPANY, BANK_GL);
    expect(result.matched).toBe(2);
    expect(result.skippedRefused).toBe(1);
  });

  it('RECONCILIATION_NOT_FOUND (the session was cancelled) re-throws and rolls the whole run savepoint back', async () => {
    const err = new BankMatchTargetError('RECONCILIATION_NOT_FOUND', 'Reconciliation r not found');
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw err;
      return { id: txId };
    });
    // D12: a run into a session locks it (FOR SHARE) first and reads its status — in progress here.
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([{ id: 'r', status: 'in_progress' }] as never);
    queueCandidates();
    await expect(autoMatchTransactions(COMPANY, BANK_GL, 'r')).rejects.toBe(err);
    expect(sp.rolledBack, 'the run savepoint rolled back (the earlier match is discarded)').toBeGreaterThanOrEqual(1);
    expect(sp.names).toContain('auto_match_run');
  });

  it('re-throws when EVERY attempted candidate was held', async () => {
    const err = new BankTransactionLockTimeoutError(TX(1));
    matchMock.mockImplementation(async () => { throw err; });
    await expect(autoMatchTransactions(COMPANY, BANK_GL)).rejects.toBe(err);
  });

  it('does not re-throw when only some were held and the others were raced or matched', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(1)) throw new BankTransactionLockTimeoutError(txId);
      if (txId === TX(2)) throw new BankTransactionAllocatedError(txId, 'allocated');
      return { id: txId };
    });
    expect((await autoMatchTransactions(COMPANY, BANK_GL)).matched).toBe(1);
  });

  // A locked TABLE is skipped like a race — the run must not lose the matches
  // already applied — but it is NOT a race, and `skippedRaced` reaches the user
  // as "allocated by another request". Counting it there says something false
  // about a row nothing is known about.
  it('counts a table-lock skip apart from the raced ones', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new BankMatchUnavailableError(txId);
      return { id: txId };
    });

    const result = await autoMatchTransactions(COMPANY, BANK_GL);

    expect(matchMock.mock.calls.map((c) => c[1])).toEqual([TX(1), TX(2), TX(3)]);
    expect(result.matched).toBe(2);
    expect(result.skippedRaced).toBe(0);
    expect(result.skippedUnavailable).toBe(1);
  });

  // Adjacent case: a raced row and a locked table in the same run are reported
  // as the two different things they are.
  it('separates the two counters when both happen in one run', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(1)) throw new BankTransactionLockTimeoutError(txId);
      if (txId === TX(2)) throw new BankMatchUnavailableError(txId);
      return { id: txId };
    });

    const result = await autoMatchTransactions(COMPANY, BANK_GL);

    expect(result.matched).toBe(1);
    expect(result.skippedRaced).toBe(1);
    expect(result.skippedUnavailable).toBe(1);
  });

  // D11 round 6: a TYPED refusal of one candidate (a reversed / missing journal line) is a state of that candidate, not of
  // the run: skipped inside its savepoint and counted, never a 4xx after earlier matches committed.
  it.each(['LINE_REVERSED', 'LINE_NOT_FOUND'] as const)('skips a typed %s refusal mid-run, counts it, earlier match stands', async (code) => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new BankMatchTargetError(code, `Journal line jl-2: ${code}`);
      return { id: txId };
    });
    const result = await autoMatchTransactions(COMPANY, BANK_GL);
    expect(matchMock.mock.calls.map((c) => c[1])).toEqual([TX(1), TX(2), TX(3)]);
    expect(result.matched).toBe(2);
    expect(result.skippedRefused).toBe(1);
    expect(result.skippedRaced).toBe(0);
  });

  it('still propagates a failure that is not a race', async () => {
    matchMock.mockImplementation(async (_c: string, txId: string) => {
      if (txId === TX(2)) throw new Error('FK violation');
      return { id: txId };
    });

    await expect(autoMatchTransactions(COMPANY, BANK_GL)).rejects.toThrow('FK violation');
  });
});
