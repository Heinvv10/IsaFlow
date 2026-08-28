/**
 * match / unmatch / exclude must lock the row and refuse to overwrite an
 * allocation.
 *
 * All three used to be a bare UPDATE with no lock and no status predicate. A
 * request that had read the row as `imported` could therefore land on top of an
 * allocation another request committed in between: the status went back to
 * `matched` / `imported` / `excluded`, `matched_journal_line_id` was
 * overwritten or nulled, and the journal that had been posted stayed in the GL
 * with nothing pointing at it. Undoing an allocation is
 * `reverseReconciledTransaction`'s job — it posts the contra.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  return { sql: vi.fn(async () => [] as unknown[]), fmtDate: actual.fmtDate };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { enterFakeRequestCtx } from '../helpers/requestCtx';
import {
  matchTransaction,
  unmatchTransaction,
  excludeTransaction,
  BankTransactionAllocatedError,
} from '@/modules/accounting/services/bank/bankTxStatusMutations';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const TX_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const JL_ID = 'cccccccc-0000-0000-0000-cccccccccccc';

function sqlTextOf(callIdx: number): string {
  const call = vi.mocked(sql).mock.calls[callIdx];
  if (!call) throw new Error(`no sql call #${callIdx}`);
  const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
  return strings
    .map((str, i) => str + (i < values.length ? (typeof values[i] === 'string' ? values[i] : '?') : ''))
    .join('');
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID, company_id: COMPANY_ID, status: 'imported', matched_journal_line_id: null,
    bank_account_id: 'dddddddd-0000-0000-0000-dddddddddddd', transaction_date: '2026-08-01',
    amount: -100, description: 'x', ...overrides,
  };
}

/** The three mutations, each with the call that performs it. */
const MUTATIONS: Array<{ name: string; run: () => Promise<unknown> }> = [
  { name: 'matchTransaction', run: () => matchTransaction(COMPANY_ID, TX_ID, JL_ID) },
  { name: 'unmatchTransaction', run: () => unmatchTransaction(COMPANY_ID, TX_ID) },
  { name: 'excludeTransaction', run: () => excludeTransaction(COMPANY_ID, TX_ID, 'dup') },
];

describe('bank transaction status mutations — locked and guarded', () => {
  beforeEach(() => {
    vi.mocked(sql).mockReset();
    enterFakeRequestCtx();
  });

  for (const { name, run } of MUTATIONS) {
    it(`${name} takes the row lock before it writes`, async () => {
      vi.mocked(sql)
        .mockResolvedValueOnce([row()] as never)   // locked read
        .mockResolvedValueOnce([row()] as never);  // the UPDATE

      await run();

      const lockText = sqlTextOf(0);
      expect(lockText).toMatch(/FROM bank_transactions/);
      expect(lockText).toMatch(/FOR UPDATE/);
      expect(lockText).toContain(COMPANY_ID);
      expect(lockText).toContain(TX_ID);
      expect(sqlTextOf(1)).toMatch(/UPDATE bank_transactions/);
    });

    it(`${name} refuses a row that already carries a posted journal`, async () => {
      vi.mocked(sql).mockResolvedValueOnce([
        row({ status: 'allocated', matched_journal_line_id: JL_ID }),
      ] as never);

      await expect(run()).rejects.toBeInstanceOf(BankTransactionAllocatedError);
      // Refused BEFORE the UPDATE — the locked read is the only statement.
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    });

    it(`${name} refuses a reconciled row too`, async () => {
      vi.mocked(sql).mockResolvedValueOnce([
        row({ status: 'reconciled', matched_journal_line_id: JL_ID }),
      ] as never);

      await expect(run()).rejects.toThrow(/reverse the allocation/);
    });

    it(`${name} reports NOT_FOUND from the locked read`, async () => {
      vi.mocked(sql).mockResolvedValueOnce([] as never);

      await expect(run()).rejects.toThrow(`Bank transaction ${TX_ID} not found`);
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    });

    it(`${name} still proceeds on an allocated row with no journal linked`, async () => {
      // `allocated` with a NULL matched_journal_line_id is a half-finished
      // state, not a posted one — there is no journal to orphan, so refusing
      // would strand the row with no way back.
      vi.mocked(sql)
        .mockResolvedValueOnce([row({ status: 'allocated', matched_journal_line_id: null })] as never)
        .mockResolvedValueOnce([row()] as never);

      await expect(run()).resolves.toBeDefined();
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(2);
    });
  }
});
