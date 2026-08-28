/**
 * The allocate row lock, proven against a real Postgres.
 *
 * Session A allocates a freshly-inserted transaction and does NOT commit.
 * Session B then tries to allocate the SAME transaction with a 500ms
 * `lock_timeout`. With `FOR UPDATE` on the first read, B blocks on A's row lock
 * and dies with 55P03 (lock_not_available) — it never reaches the journal post.
 *
 * The rejection alone does NOT prove the fix: without `FOR UPDATE`, B sails
 * past the (still-`imported`, because A is uncommitted) status check, posts a
 * SECOND journal, and only then blocks on the row when it UPDATEs the status —
 * failing with the same 55P03. So the test also records every statement B
 * issues and asserts it never got as far as an INSERT. Drop `FOR UPDATE` and
 * that assertion goes red on `INSERT INTO gl_journal_entries`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';

type Ctx = Parameters<typeof als.run>[0];
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

// Any real user id would do; the column is nullable and unvalidated here.
const USER_ID = '00000000-0000-0000-0000-0000000000aa';

interface Fixture {
  companyId: string;
  bankAccountId: string;
  expenseAccountId: string;
}

/** A company that has both an active bank GL account and an active expense one. */
async function findFixture(client: PoolClient): Promise<Fixture | null> {
  const { rows } = await client.query<{
    company_id: string;
    bank_id: string;
    exp_id: string;
  }>(`
    SELECT b.company_id, b.id AS bank_id, e.id AS exp_id
    FROM gl_accounts b
    JOIN gl_accounts e
      ON e.company_id = b.company_id AND e.account_type = 'expense' AND e.is_active
    WHERE b.account_subtype = 'bank' AND b.is_active
    LIMIT 1
  `);
  const r = rows[0];
  return r ? { companyId: r.company_id, bankAccountId: r.bank_id, expenseAccountId: r.exp_id } : null;
}

describe('allocateTransaction — concurrent allocation blocks on the row lock', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('second session hits lock_timeout instead of posting a second journal', async () => {
    const pool = getPoolForTests();
    const setup = await pool.connect();
    let fixture: Fixture | null = null;
    let txId: string | null = null;
    try {
      fixture = await findFixture(setup);
      if (!fixture) {
        // No seeded COA in this database — nothing meaningful to assert.
        expect(fixture).toBeNull();
        return;
      }
      // Committed, so session B can see (and block on) the row.
      const ins = await setup.query<{ id: string }>(
        `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
         VALUES ($1, $2, CURRENT_DATE, -101.00, 'row-lock test fixture', 'imported')
         RETURNING id`,
        [fixture.companyId, fixture.bankAccountId],
      );
      txId = ins.rows[0]!.id;

      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        await als.run(ctxFor(a, fixture.companyId), () =>
          allocateTransaction(fixture!.companyId, txId!, fixture!.expenseAccountId, USER_ID, 'A allocates'),
        );
        // A deliberately stays open: its row lock is what B must hit.

        await b.query('BEGIN');
        await b.query("SET LOCAL lock_timeout = '500ms'");
        const bQueries: string[] = [];
        const attempt = als.run(recordingCtx(b, fixture.companyId, bQueries), () =>
          allocateTransaction(fixture!.companyId, txId!, fixture!.expenseAccountId, USER_ID, 'B allocates'),
        );
        await expect(attempt).rejects.toMatchObject({ code: '55P03' });

        // B blocked on its very FIRST statement — the locked read — so it wrote
        // nothing. Without the lock it reaches INSERT INTO gl_journal_entries.
        expect(bQueries[0]).toMatch(/FROM bank_transactions/);
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
