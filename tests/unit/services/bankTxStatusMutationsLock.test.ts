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

/**
 * The three mutations, each with the call that performs it and the reads it
 * makes between the locked read and its own UPDATE.
 *
 * `matchTransaction` checks that the journal line belongs to the caller's
 * company and is not already claimed by another bank transaction, so it has two
 * of those; the other two write straight after the lock. Queueing them here
 * keeps every shared assertion below counting statements rather than hard-coding
 * one mutation's shape.
 */
const MUTATIONS: Array<{ name: string; run: () => Promise<unknown>; preWrite: unknown[][] }> = [
  {
    name: 'matchTransaction',
    run: () => matchTransaction(COMPANY_ID, TX_ID, JL_ID),
    preWrite: [[{ id: JL_ID }], []],
  },
  { name: 'unmatchTransaction', run: () => unmatchTransaction(COMPANY_ID, TX_ID), preWrite: [] },
  { name: 'excludeTransaction', run: () => excludeTransaction(COMPANY_ID, TX_ID, 'dup'), preWrite: [] },
];

describe('bank transaction status mutations — locked and guarded', () => {
  beforeEach(() => {
    vi.mocked(sql).mockReset();
    enterFakeRequestCtx();
  });

  for (const { name, run, preWrite } of MUTATIONS) {
    /** Queue the locked read, this mutation's ownership reads, then its UPDATE. */
    function queue(lockRow: unknown[], update: unknown[]) {
      const m = vi.mocked(sql).mockResolvedValueOnce(lockRow as never);
      for (const r of preWrite) m.mockResolvedValueOnce(r as never);
      m.mockResolvedValueOnce(update as never);
    }
    /** Statements a successful run issues: the lock, the ownership reads, the UPDATE. */
    const totalCalls = 2 + preWrite.length;

    it(`${name} takes the row lock before it writes`, async () => {
      queue([row()], [row()]);

      await run();

      const lockText = sqlTextOf(0);
      expect(lockText).toMatch(/FROM bank_transactions/);
      expect(lockText).toMatch(/FOR UPDATE/);
      expect(lockText).toContain(COMPANY_ID);
      expect(lockText).toContain(TX_ID);
      expect(sqlTextOf(1 + preWrite.length)).toMatch(/UPDATE bank_transactions/);
    });

    it(`${name} refuses a row that already carries a posted journal`, async () => {
      vi.mocked(sql).mockResolvedValueOnce([
        row({ status: 'allocated', matched_journal_line_id: JL_ID }),
      ] as never);

      await expect(run()).rejects.toBeInstanceOf(BankTransactionAllocatedError);
      // Refused BEFORE the UPDATE — the locked read is the only statement.
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    });

    it(`${name} still allows a reconciled row`, async () => {
      // `reconciled` is NOT an allocation. A row only reaches it through
      // matchTransaction (bankReconciliationService promotes rows that are
      // already `matched`), so its journal was written by something else and
      // pre-dates the link — unmatching it orphans nothing. The bank table also
      // still shows Undo on these, so refusing would be a 400 on a live button.
      queue([row({ status: 'reconciled', matched_journal_line_id: JL_ID })], [row()]);

      await expect(run()).resolves.toBeDefined();
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(totalCalls);
    });

    it(`${name} reports NOT_FOUND from the locked read`, async () => {
      vi.mocked(sql).mockResolvedValueOnce([] as never);

      await expect(run()).rejects.toThrow(`Bank transaction ${TX_ID} not found`);
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    });

    it(`${name} reports NOT_FOUND when the UPDATE itself matches nothing`, async () => {
      // The row was deleted between the locked read and the write. Distinct
      // from the read-side miss above: this is the UPDATE's own empty RETURNING,
      // which is the branch that would otherwise map an empty row array.
      queue([row()], []);  // locked read finds it, UPDATE returns nothing

      await expect(run()).rejects.toThrow(`Bank transaction ${TX_ID} not found`);
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(totalCalls);
    });

    it(`${name} still proceeds on an allocated row with no journal linked`, async () => {
      // `allocated` with a NULL matched_journal_line_id is a half-finished
      // state, not a posted one — there is no journal to orphan, so refusing
      // would strand the row with no way back.
      queue([row({ status: 'allocated', matched_journal_line_id: null })], [row()]);

      await expect(run()).resolves.toBeDefined();
      expect(vi.mocked(sql)).toHaveBeenCalledTimes(totalCalls);
    });
  }

  // K-144: the ownership reads matchTransaction adds are the guard itself, so
  // they get their own assertions rather than only being counted above.
  it('matchTransaction refuses a journal line the company does not own', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([row()] as never)  // locked read
      .mockResolvedValueOnce([] as never);      // the line is not in this company

    await expect(matchTransaction(COMPANY_ID, TX_ID, JL_ID))
      .rejects.toThrow(`Journal line ${JL_ID} not found`);
    expect(sqlTextOf(1)).toMatch(/FROM gl_journal_lines/);
    expect(sqlTextOf(1)).toContain(COMPANY_ID);
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(2);
  });

  it('matchTransaction refuses a journal line another transaction already holds', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([row()] as never)
      .mockResolvedValueOnce([{ id: JL_ID }] as never)
      .mockResolvedValueOnce([{ id: 'eeeeeeee-0000-0000-0000-eeeeeeeeeeee' }] as never);

    await expect(matchTransaction(COMPANY_ID, TX_ID, JL_ID)).rejects.toThrow(/already matched/i);
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);
  });
});
