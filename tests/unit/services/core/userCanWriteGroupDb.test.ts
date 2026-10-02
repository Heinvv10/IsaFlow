/**
 * D4 round 6 LOW-2, against Postgres: `userCanWriteGroup` says yes only for an owner / admin /
 * manager of a CURRENT member company of the group. Temp tables shadow the real ones on this
 * connection, in a rolled-back transaction — no persistent writes.
 */
import { describe, expect, it, vi } from 'vitest';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { userBelongsToGroup, userCanWriteGroup } from '@/modules/accounting/services/core/companyAccessService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const GROUP = '80000000-0000-4000-8000-000000000001';
const OTHER_GROUP = '80000000-0000-4000-8000-000000000002';
const IN = '10000000-0000-4000-8000-0000000000a1';
const LEFT = '10000000-0000-4000-8000-0000000000a2';
const OUTSIDE = '10000000-0000-4000-8000-0000000000a3';

describe('userCanWriteGroup (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('write role in a current member company only', async () => {
    assertNotProductionDb('userCanWriteGroup');
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run({ client, companyId: IN, userId: '', claims: {} }, async () => {
        await sql`CREATE TEMP TABLE company_group_members (group_id uuid, company_id uuid, left_date date) ON COMMIT DROP`;
        await sql`CREATE TEMP TABLE company_users (company_id uuid, user_id text, role text) ON COMMIT DROP`;
        await sql`INSERT INTO company_group_members VALUES (${GROUP}::uuid, ${IN}::uuid, NULL),
          (${GROUP}::uuid, ${LEFT}::uuid, '2026-01-31'), (${OTHER_GROUP}::uuid, ${OUTSIDE}::uuid, NULL)`;
        await sql`INSERT INTO company_users VALUES
          (${IN}::uuid, 'viewer', 'viewer'), (${IN}::uuid, 'owner', 'owner'), (${IN}::uuid, 'admin', 'admin'),
          (${IN}::uuid, 'manager', 'manager'), (${LEFT}::uuid, 'left-admin', 'admin'),
          (${OUTSIDE}::uuid, 'outside-admin', 'admin'), (${IN}::uuid, 'mixed', 'viewer'), (${OUTSIDE}::uuid, 'mixed', 'admin')`;
        const verdict = async (user: string) => [await userBelongsToGroup(user, GROUP), await userCanWriteGroup(user, GROUP)];
        expect(await verdict('owner')).toEqual([true, true]);
        expect(await verdict('admin')).toEqual([true, true]);
        expect(await verdict('manager')).toEqual([true, true]);
        expect(await verdict('viewer')).toEqual([true, false]);       // reads, may not write
        expect(await verdict('left-admin')).toEqual([false, false]);  // company left the group
        expect(await verdict('outside-admin')).toEqual([false, false]);
        expect(await verdict('mixed')).toEqual([true, false]);        // admin elsewhere does not count
      });
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  });
});
