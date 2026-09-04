/**
 * `mergeAccounts` takes the row lock, on both accounts, before it reads
 * anything it then acts on.
 *
 * Split from `accountMergeLockDb.test.ts`, which proves the helper really
 * blocks. That file needs two connections and therefore committed rows; this
 * one does not, because the lock is mocked and what is under test is the
 * CALL — so the fixture can build its own tenant inside a rolled-back
 * transaction like every other merge suite.
 *
 * Two halves, each properly tested, make the chain: the helper locks (there),
 * and the service asks it to (here). An earlier version tried to do both at
 * once by probing the target row from a second connection, and could not
 * distinguish the helper's lock from the FOR KEY SHARE the foreign key takes
 * when journal lines are repointed onto that same row.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertMergeTestDb, createMergeFixture } from '../helpers/accountMergeFixture';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/glAccountLock', () => ({
  lockGlAccountsForUpdate: vi.fn(async () => []),
  GlAccountLockTimeoutError: class extends Error {},
}));

import { getPoolForTests } from '@/lib/neon';
import { lockGlAccountsForUpdate } from '@/modules/accounting/services/gl/glAccountLock';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: '00000000-0000-0000-0000-0000000000aa', companyId, claims: {} } as unknown as Ctx);

describe('mergeAccounts and the row lock', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('locks BOTH accounts before it writes', async () => {
    assertMergeTestDb();
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      const f = await createMergeFixture(client);
      await als.run(ctxFor(client, f.companyId), () =>
        mergeAccounts(f.companyId, f.cleanSourceId, f.targetId));

      expect(lockGlAccountsForUpdate).toHaveBeenCalledTimes(1);
      expect(lockGlAccountsForUpdate).toHaveBeenCalledWith(
        f.companyId, [f.cleanSourceId, f.targetId],
      );
      // Both ids, not just the source: the source is UPDATEd anyway
      // (is_active = false) and would be locked regardless; the target is never
      // written, so only this call protects it.
      const args = vi.mocked(lockGlAccountsForUpdate).mock.calls[0]![1];
      expect([...args].sort()).toEqual([f.cleanSourceId, f.targetId].sort());
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 60_000);
});
