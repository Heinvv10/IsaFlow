/**
 * The row lock that stops two opposite merges deactivating both accounts.
 *
 * Follows `bank/bankTxLock.ts` — the same `FOR UPDATE` plus 5s `lock_timeout`
 * pair, on the same reasoning, so there is one idiom on this table rather than
 * two. The timeout is asserted, not just the lock: without it a merge blocking
 * behind a long-running transaction on a control account waits forever inside
 * the registry's savepoint.
 *
 * `merge(A -> B)` and `merge(B -> A)` carry different idempotency keys, so the
 * registry's per-key lock never sees them as the same call. Under READ
 * COMMITTED each passes every guard against its own snapshot, each moves its own
 * lines, and both set `is_active = false` — leaving the combined balance
 * stranded across two dead accounts.
 *
 * Proven the only way it can be: a second connection holds one of the two rows
 * and the lock has to BLOCK, surfacing as GlAccountLockTimeoutError when the
 * helper's own 5s timeout elapses. Remove the `FOR UPDATE` and the statement
 * returns immediately instead; remove the `SET LOCAL lock_timeout` and this
 * hangs until the test's own timeout. Both go red.
 *
 * What is NOT covered here, deliberately: the ASCENDING ID ORDER itself. A
 * deadlock needs each party to hold one row and want the other, and when both
 * parties acquire through this helper that state is only reachable by winning a
 * race between them — a test for it passes or fails on scheduling, which is
 * noise rather than proof. (Two other routes were tried and are dead ends: which
 * row times out is identical under both orderings, and inspecting what the loser
 * still holds does not work either, because a lock_timeout abort releases the
 * row locks the transaction had already taken — verified against this Postgres.)
 * The ordering is correct by construction instead: one statement per id, in
 * sorted order, so no plan choice and no argument order can reorder it.
 *
 * Nothing commits: the first case only takes row locks on existing accounts,
 * the second runs a real merge inside a transaction that is rolled back.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import {
  assertMergeTestDb, createMergeFixture, MERGE_COMPANY_ID,
} from '../helpers/accountMergeFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';
import {
  lockGlAccountsForUpdate,
  GlAccountLockTimeoutError,
} from '@/modules/accounting/services/gl/glAccountLock';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: '00000000-0000-0000-0000-0000000000aa', companyId, claims: {} } as unknown as Ctx);

describe('lockGlAccountsForUpdate', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('blocks on a row another transaction already holds', async () => {
    assertMergeTestDb();
    const pool = getPoolForTests();
    const holder = await pool.connect();
    const waiter = await pool.connect();
    try {
      const { rows } = await holder.query<{ id: string }>(
        'SELECT id FROM gl_accounts WHERE company_id = $1 ORDER BY id LIMIT 2',
        [MERGE_COMPANY_ID],
      );
      expect(rows).toHaveLength(2);
      const [a, b] = [rows[0]!.id, rows[1]!.id];

      await holder.query('BEGIN');
      await holder.query('SELECT id FROM gl_accounts WHERE id = $1 FOR UPDATE', [b]);

      await waiter.query('BEGIN');
      await als.run(ctxFor(waiter, MERGE_COMPANY_ID), async () => {
        // The helper sets its own 5s lock_timeout, so this waits ~5s and then
        // surfaces as the named error rather than hanging.
        await expect(lockGlAccountsForUpdate(MERGE_COMPANY_ID, [a, b]))
          .rejects.toBeInstanceOf(GlAccountLockTimeoutError);
      });
    } finally {
      await waiter.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      waiter.release();
      holder.release();
    }
  }, 60_000);

  it.skipIf(!reachable)('is actually taken by a merge, on the target as well as the source', async () => {
    // The merge UPDATEs the source row itself (is_active = false), so the source
    // would be locked with or without the helper. The target row is never
    // written — but repointing journal lines onto it takes a FOR KEY SHARE lock
    // through the foreign key, so probing with FOR UPDATE cannot tell the
    // helper's lock from the FK's and passes either way (checked: it does).
    // FOR KEY SHARE is the discriminator: it conflicts with the helper's
    // FOR UPDATE and not with the FK's own KEY SHARE.
    //
    // The target has to be a COMMITTED account — the fixture's own rows are
    // invisible to a second connection.
    assertMergeTestDb();
    const pool = getPoolForTests();
    const runner = await pool.connect();
    const prober = await pool.connect();
    try {
      const { rows } = await runner.query<{ id: string }>(
        `SELECT id FROM gl_accounts
          WHERE company_id = $1 AND account_type = 'asset' AND is_active
            AND (account_subtype IS NULL OR account_subtype IN ('receivable', 'payable'))
          ORDER BY account_code LIMIT 1`,
        [MERGE_COMPANY_ID],
      );
      const committedTarget = rows[0]!.id;

      await runner.query('BEGIN');
      const fixture = await createMergeFixture(runner);
      await als.run(ctxFor(runner, MERGE_COMPANY_ID), () =>
        mergeAccounts(MERGE_COMPANY_ID, fixture.cleanSourceId, committedTarget));

      await prober.query('BEGIN');
      await prober.query("SET LOCAL lock_timeout = '400ms'");
      await expect(
        prober.query('SELECT id FROM gl_accounts WHERE id = $1 FOR KEY SHARE', [committedTarget]),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await prober.query('ROLLBACK').catch(() => undefined);
      await runner.query('ROLLBACK').catch(() => undefined);
      prober.release();
      runner.release();
    }
  }, 60_000);
});
