/**
 * The row lock that stops two opposite merges deactivating both accounts.
 *
 * `merge(A -> B)` and `merge(B -> A)` carry different idempotency keys, so the
 * registry's per-key lock never sees them as the same call. Under READ
 * COMMITTED each passes every guard against its own snapshot, each moves its own
 * lines, and both set `is_active = false` — leaving the combined balance
 * stranded across two dead accounts.
 *
 * Proven the only way it can be: a second connection holds one of the two rows
 * and the merge has to BLOCK. With a short `lock_timeout` that surfaces as
 * 55P03. Remove the `FOR UPDATE` from `lockAccountsForMerge` and the statement
 * returns immediately instead, and this goes red.
 *
 * Read-only: two existing committed accounts are locked and both transactions
 * are rolled back. Nothing is written.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertMergeTestDb, MERGE_COMPANY_ID } from '../helpers/accountMergeFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { lockAccountsForMerge } from '@/modules/accounting/services/gl/accountMergeService';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: '00000000-0000-0000-0000-0000000000aa', companyId, claims: {} } as unknown as Ctx);

describe('lockAccountsForMerge', async () => {
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
      await waiter.query("SET LOCAL lock_timeout = '400ms'");
      await als.run(ctxFor(waiter, MERGE_COMPANY_ID), async () => {
        await expect(lockAccountsForMerge(MERGE_COMPANY_ID, a, b))
          .rejects.toMatchObject({ code: '55P03' });
      });
    } finally {
      await waiter.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      waiter.release();
      holder.release();
    }
  }, 60_000);
});
