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
 * sorted order, so no argument order can reorder it. (A single
 * `ORDER BY id ... FOR UPDATE` would be equally correct — `LockRows` is the
 * topmost node whether or not the scan supplies the order — and is what a
 * caller locking hundreds of rows should use. See the helper's docblock.)
 *
 * Nothing commits: this only takes row locks on two existing chart rows, and
 * both transactions are rolled back. That `mergeAccounts` actually CALLS this
 * helper is proven separately, in accountMergeCallsLockDb.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertMergeTestDb } from '../helpers/accountMergeFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import {
  lockGlAccountsForUpdate,
  GlAccountLockTimeoutError,
} from '@/modules/accounting/services/gl/glAccountLock';

/**
 * The one place these tests touch a shared tenant, and it is unavoidable: a lock
 * only exists between two CONNECTIONS, so the rows have to be committed, and a
 * company created inside the test transaction is invisible to the second
 * connection. The exposure is bounded — two chart rows, read-only, `FOR UPDATE`
 * for at most the 5s timeout, both transactions rolled back, nothing written.
 * Everything else in the merge suites now builds its own tenant.
 */
const SHARED_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

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
        [SHARED_COMPANY_ID],
      );
      expect(rows).toHaveLength(2);
      const [a, b] = [rows[0]!.id, rows[1]!.id];

      await holder.query('BEGIN');
      await holder.query('SELECT id FROM gl_accounts WHERE id = $1 FOR UPDATE', [b]);

      await waiter.query('BEGIN');
      await als.run(ctxFor(waiter, SHARED_COMPANY_ID), async () => {
        // The helper sets its own 5s lock_timeout, so this waits ~5s and then
        // surfaces as the named error rather than hanging.
        await expect(lockGlAccountsForUpdate(SHARED_COMPANY_ID, [a, b]))
          .rejects.toBeInstanceOf(GlAccountLockTimeoutError);
      });
    } finally {
      await waiter.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      waiter.release();
      holder.release();
    }
  }, 60_000);

});
