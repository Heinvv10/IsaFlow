/**
 * Budgets P1 (migration 947): a CC1, CC2 or business unit that a budget amount carries cannot be
 * deleted, and the refusal is the masters' own counted message naming "budget amount(s)", not a raw
 * 23503 (the composite FK is the backstop). Run as the services run inside a request transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { deleteCostCentre } from '@/modules/accounting/services/core/costCentreService';
import { deleteBusinessUnit } from '@/modules/accounting/services/core/businessUnitService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const { A, setup, cleanup, version, amount } = budgetVersionFixture(pool);

beforeAll(setup);
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

/** The delete in a request-shaped transaction, rolled back; its refusal message, or 'deleted'. */
async function attempt(fn: () => Promise<void>): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await als.run({ client: c, companyId: A.id, userId: A.user, claims: {} } as never, fn);
    return 'deleted';
  } catch (err) {
    return (err as Error).message;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('P1: dimension masters a budget uses cannot be deleted', () => {
  it('a CC1, a CC2 and a BU each refuse with a count of budget amounts', async () => {
    const v = await version(A);
    await amount(A, v, { acct: A.acct, cc1: A.cc1 });
    await amount(A, v, { acct: A.acct2, cc2: A.cc2 });
    const w = await version(A);
    await amount(A, w, { acct: A.acct, bu: A.bu });
    expect(await attempt(() => deleteCostCentre(A.id, A.cc1))).toMatch(/used by 1 budget amount\(s\)/);
    expect(await attempt(() => deleteCostCentre(A.id, A.cc2))).toMatch(/used by 1 budget amount\(s\)/);
    expect(await attempt(() => deleteBusinessUnit(A.id, A.bu))).toMatch(/used by 1 budget amount\(s\)/);
  });

  it('a centre no budget uses still deletes', async () => {
    expect(await attempt(() => deleteCostCentre(A.id, A.cc1b))).toBe('deleted');
  });
});
