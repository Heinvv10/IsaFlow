/**
 * The allocate row lock, proven against a real Postgres.
 *
 * Session A allocates a freshly-inserted transaction and does NOT commit.
 * Session B then tries to allocate the SAME transaction; the helper's 5s
 * `lock_timeout` fires and B dies with `BankTransactionLockTimeoutError` — it
 * never reaches the journal post.
 *
 * The rejection alone does NOT prove the fix: without `FOR UPDATE`, B sails
 * past the (still-`imported`, because A is uncommitted) status check, posts a
 * SECOND journal, and only then blocks on the row when it UPDATEs the status —
 * failing with the same 55P03. So the test also records every statement B
 * issues and asserts it never got as far as an INSERT. Drop `FOR UPDATE` and
 * that assertion goes red on `INSERT INTO gl_journal_entries`.
 *
 * This test WRITES (it inserts and deletes a bank transaction), so it refuses
 * to run against the production database.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import {
  assertNotProductionDb,
  findBankFixture,
  insertImportedTx,
  type BankFixture,
} from '../helpers/bankDbFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';

type Ctx = Parameters<typeof als.run>[0];

// Any real user id would do; the column is nullable and unvalidated here.
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function ctxFor(client: PoolClient, companyId: string): Ctx {
  return { client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

/**
 * ALS-shaped client that records the SQL it forwards, so the test can see how
 * far the second session got before the lock stopped it.
 */
function recordingCtx(client: PoolClient, companyId: string, sink: string[]): Ctx {
  const proxy = {
    query: (text: string, params?: unknown[]) => {
      sink.push(text);
      return client.query(text, params as never[]);
    },
  };
  return { client: proxy, userId: USER_ID, companyId, claims: {} } as unknown as Ctx;
}

describe('allocateTransaction — concurrent allocation blocks on the row lock', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('second session waits on the lock instead of posting a second journal', async (ctx) => {
    assertNotProductionDb();
    const pool = getPoolForTests();
    const setup = await pool.connect();
    let fixture: BankFixture | null = null;
    let txId: string | null = null;
    try {
      fixture = await findBankFixture(setup);
      if (!fixture) {
        // No seeded chart of accounts here — skip loudly rather than passing on
        // an assertion that never ran.
        ctx.skip('no company with both a bank and an expense GL account');
        return;
      }
      // Committed, so session B can see (and block on) the row.
      txId = await insertImportedTx(setup, fixture, 'row-lock test fixture');

      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        await als.run(ctxFor(a, fixture.companyId), () =>
          allocateTransaction(fixture!.companyId, txId!, fixture!.expenseAccountId, USER_ID, 'A allocates'),
        );
        // A deliberately stays open: its row lock is what B must hit.

        await b.query('BEGIN');
        const bQueries: string[] = [];
        const attempt = als.run(recordingCtx(b, fixture.companyId, bQueries), () =>
          allocateTransaction(fixture!.companyId, txId!, fixture!.expenseAccountId, USER_ID, 'B allocates'),
        );
        // The helper's own 5s lock_timeout, surfaced as the retryable error.
        await expect(attempt).rejects.toBeInstanceOf(BankTransactionLockTimeoutError);

        // B blocked on its very FIRST read — the locked one — so it wrote
        // nothing. Without the lock it reaches INSERT INTO gl_journal_entries.
        expect(bQueries.find((q) => /FROM bank_transactions/.test(q))).toMatch(/FOR UPDATE/);
        expect(bQueries.filter((q) => /^\s*INSERT\s/i.test(q))).toEqual([]);
      } finally {
        await a.query('ROLLBACK').catch(() => undefined);
        await b.query('ROLLBACK').catch(() => undefined);
        a.release();
        b.release();
      }
    } finally {
      if (txId) {
        await setup.query('DELETE FROM bank_transactions WHERE id = $1', [txId]).catch(() => undefined);
      }
      setup.release();
    }
  }, 30_000);
});
