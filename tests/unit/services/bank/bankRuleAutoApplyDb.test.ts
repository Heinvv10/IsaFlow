/**
 * `createRule` against a real Postgres, because the defect it pins is
 * INVISIBLE to a mocked one.
 *
 * `bank_categorisation_rules.auto_apply` (migration 676) is NOT NULL with a
 * DEFAULT. The service bound the caller's value straight through, and a
 * parameter bound as `undefined` reaches pg as an explicit NULL — which, in an
 * INSERT's column list, does NOT take the column default. It violates the NOT
 * NULL and raises 23502. So every rule created WITHOUT naming a mode — the
 * normal case from the UI and from the REST route — failed outright, while the
 * mocked unit test beside this one passed, because its `sql` never saw the
 * constraint.
 *
 * That is the reason this file exists: a column default, a NOT NULL and a bound
 * `undefined` are three facts only the database holds.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { createRule, updateRule } from '@/modules/accounting/services/bank/bankRulesService';

const USER = '00000000-0000-0000-0000-0000000000bb';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: USER, companyId, claims: {} } as unknown as Ctx);

let dbUp = false;
beforeAll(async () => { dbUp = await isDbReachable(); });

function input() {
  return {
    ruleName: 'Reload Somerset W',
    matchField: 'description' as const,
    matchType: 'contains' as const,
    // Unique per call: nothing here relies on a rule being the only one, but a
    // shared pattern across tests would make a future uniqueness rule flaky.
    matchPattern: `RELOAD-${randomUUID().slice(0, 8)}`,
  };
}

/** A company of this test's own, seeded then rolled back. */
async function withCompany<T>(fn: (companyId: string) => Promise<T>): Promise<T> {
  assertNotProductionDb();
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const { rows: [co] } = await client.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ('Bank Rule Fixture') RETURNING id`,
    );
    const companyId = co!.id;
    return await als.run(ctxFor(client, companyId), () => fn(companyId));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('createRule — auto_apply against a real database', () => {
  it('creates a rule that names NO mode, and it reads back as fifo', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId) => {
      // The call that used to raise 23502: no auto_apply anywhere in the input.
      const rule = await createRule(companyId, input(), USER);
      expect(rule.autoApply).toBe('fifo');
    });
  }, 60000);

  it('stores the mode the caller chose', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId) => {
      const rule = await createRule(companyId, { ...input(), autoApply: 'none' }, USER);
      expect(rule.autoApply).toBe('none');
    });
  }, 60000);

  it('changes the mode on an existing rule, and leaves it alone when unnamed', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId) => {
      const rule = await createRule(companyId, { ...input(), autoApply: 'none' }, USER);

      // updateRule's COALESCE path: an unnamed field keeps what the row has.
      const renamed = await updateRule(companyId, rule.id, { ruleName: 'Renamed' }, USER);
      expect(renamed.autoApply).toBe('none');

      const switched = await updateRule(companyId, rule.id, { autoApply: 'fifo' }, USER);
      expect(switched.autoApply).toBe('fifo');
    });
  }, 60000);

  it('refuses a mode that is not one, before the INSERT', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId) => {
      await expect(
        createRule(companyId, { ...input(), autoApply: 'oldest' as never }, USER),
      ).rejects.toThrow(/auto_apply must be one of/);
    });
  }, 60000);
});
