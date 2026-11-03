/**
 * Budgets P5-6 r4 (breaker round 2, REPRO 6; coordinator's ruling): a submitted or approved slice is
 * FROZEN. A driver recompute never writes into it, whatever input moved and whoever saves: the cells
 * are left as they are, the save answers `frozenDriverCells` (count + driver rows), and they
 * recalculate once the slice is returned. An owner's grid save opens the reviewer path only for the
 * locked slices its own cells are in.
 * World: COGS on CC2 (holderB's slice, approved) = 38% of Sales on CC1 (the holder's open slice).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, dataOf, type DriverWorld, type RouteOut } from './helpers/budgetDriverRouteFixture';
import { budgetHoldersFixture } from './helpers/budgetHoldersFixture';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { als } from '@/lib/als';
import { beginSliceReview, loadHolderScope } from '@/modules/accounting/services/budgets/holderScope';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
const hx = budgetHoldersFixture(pool, saveRoute);
let w: DriverWorld;
let holder: SetupUser;
let holderB: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
  holderB = await fx.member(w.u.homeCompanyId, 'manager');
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM budget_slice_reviews WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_holders WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_planned_hires WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM user_notifications WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120_000);

const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 500)}`;
type Frozen = { frozenDriverCells?: { cells: number; rows: string[] } };
const at = async (v: string, acct: string, dims: { cc1?: string; cc2?: string }, month: string) => (await pool.query(
  `SELECT amount::text FROM budget_month_amounts WHERE version_id = $1 AND gl_account_id = $2 AND cc1_id IS NOT DISTINCT FROM $3
     AND cc2_id IS NOT DISTINCT FROM $4 AND month = ($5 || '-01')::date`, [v, acct, dims.cc1 ?? null, dims.cc2 ?? null, month])).rows[0]?.amount as string | undefined;

/** V with Sales/CC1 1 000 in months 0-2, COGS/CC2 = 38% of it (380), the holder on CC1 and holderB's CC2 slice submitted (and approved). */
async function setup(approve = true): Promise<{ v: string; sliceB: string }> {
  const v = await fx.version(w);
  for (const m of w.months.slice(0, 3)) await fx.amount(w, v, w.sales, m, 1000, { cc1: w.cc1 });
  await hx.hold(w as never, v, holder.userId, { cc1: w.cc1 });
  const sliceB = await hx.hold(w as never, v, holderB.userId, { cc2: w.cc2 });
  const put = await fx.call.drivers(w.u, 'PUT', {
    versionId: v, glAccountId: w.cogs, cc2Id: w.cc2, kind: 'pct_of_line', pct: 38, fromMonth: w.months[0], toMonth: w.months[2],
    ref: { glAccountId: w.sales, cc1Id: w.cc1 },
  });
  expect(put.status, dump(put)).toBe(200);
  await hx.setStatus(sliceB, 'submitted', holderB.userId);
  if (approve) await hx.setStatus(sliceB, 'approved', w.u.userId);
  return { v, sliceB };
}

describe('an approved slice is frozen to driver recomputes', () => {
  it('REPRO 6: a holder\'s own-slice SQL write, then the owner\'s unrelated save: the approved COGS/CC2 does not move', async () => {
    const { v } = await setup();
    expect(await at(v, w.cogs, { cc2: w.cc2 }, w.months[0]!)).toBe('380.00');
    await hx.asMember(holder, (c) => c.query(`UPDATE budget_month_amounts SET amount = 100000 WHERE version_id = $1 AND gl_account_id = $2 AND cc1_id = $3`,
      [v, w.sales, w.cc1]), true);
    const s = await fx.call.save(w.u, v, [{ glAccountId: w.rent, cc1Id: null, cc2Id: null, buId: null, month: w.months[5], amount: 5 }]);
    expect(s.status, dump(s)).toBe(200);
    expect(await at(v, w.cogs, { cc2: w.cc2 }, w.months[0]!)).toBe('380.00');
    expect(dataOf<Frozen>(s).frozenDriverCells).toEqual({ cells: 3, rows: [expect.stringContaining('GS-5100 Cost of sales')] });
  });

  it('the owner\'s own save of Sales/CC1: 200, a SUBMITTED COGS/CC2 unchanged and reported; returned, the next save recalculates it', async () => {
    const { v, sliceB } = await setup(false);
    const s = await fx.call.save(w.u, v, [{ glAccountId: w.sales, cc1Id: w.cc1, cc2Id: null, buId: null, month: w.months[0], amount: 5000 }]);
    expect(s.status, dump(s)).toBe(200);
    expect(await at(v, w.sales, { cc1: w.cc1 }, w.months[0]!)).toBe('5000.00');
    expect(await at(v, w.cogs, { cc2: w.cc2 }, w.months[0]!)).toBe('380.00');
    expect(dataOf<Frozen>(s).frozenDriverCells?.cells).toBe(1);
    // The audit row records it too.
    expect((await fx.audits(v)).at(-1)!.changes.metadata).toMatchObject({ frozenDriverCells: '1' });

    await hx.setStatus(sliceB, 'returned', w.u.userId, 'Recheck');
    const again = await fx.call.save(w.u, v, [{ glAccountId: w.rent, cc1Id: null, cc2Id: null, buId: null, month: w.months[6], amount: 1 }]);
    expect(again.status, dump(again)).toBe(200);
    expect(await at(v, w.cogs, { cc2: w.cc2 }, w.months[0]!)).toBe('1900.00');
    expect(dataOf<Frozen>(again).frozenDriverCells).toBeUndefined();
  });

  it('a planned hire on the holder\'s own centre: the approved per_head slice reading it does not move', async () => {
    const v = await fx.version(w);
    await hx.hold(w as never, v, holder.userId, { cc1: w.cc1 });
    const sliceB = await hx.hold(w as never, v, holderB.userId, { cc2: w.cc2 });
    const put = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, cc2Id: w.cc2, kind: 'per_head', amount: 1000, fromMonth: w.months[0], toMonth: w.months[2],
      headcountCostCentreId: w.cc1,
    });
    expect(put.status, dump(put)).toBe(200);
    const before = await at(v, w.rent, { cc2: w.cc2 }, w.months[1]!);
    await hx.setStatus(sliceB, 'submitted', holderB.userId);
    await hx.setStatus(sliceB, 'approved', w.u.userId);
    const hire = await fx.call.hires(holder, 'POST', {
      versionId: v, label: 'Analyst', costCentreId: w.cc1, startMonth: w.months[0], endMonth: null, fte: 2,
    });
    expect(hire.status, dump(hire)).toBe(200);
    expect(await at(v, w.rent, { cc2: w.cc2 }, w.months[1]!)).toBe(before);
    expect(dataOf<Frozen>(hire).frozenDriverCells?.cells).toBeGreaterThan(0);
  });

  it('the owner\'s reviewer path opens only the locked slices of their own cells (another locked slice stays shut)', async () => {
    const v = await fx.version(w);
    const sliceA = await hx.hold(w as never, v, holder.userId, { cc1: w.cc1 });
    const sliceB = await hx.hold(w as never, v, holderB.userId, { cc2: w.cc2 });
    await hx.setStatus(sliceA, 'submitted', holder.userId);
    await hx.setStatus(sliceB, 'submitted', holderB.userId);
    const put = (c: import('pg').PoolClient, dims: { cc1?: string; cc2?: string }) => c.query(
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id) VALUES ($1, $2, $3, ($4 || '-01')::date, 1, $5, $6)`,
      [w.u.homeCompanyId, v, w.rent, w.months[4], dims.cc1 ?? null, dims.cc2 ?? null]);
    const out = await hx.asMember(w.u, async (c) => als.run({ client: c, companyId: w.u.homeCompanyId, userId: w.u.userId, claims: { sub: w.u.userId } } as never, async () => {
      const scope = await loadHolderScope(w.u.homeCompanyId, v, w.u.userId);
      await beginSliceReview(w.u.homeCompanyId, v, scope, [{ cc1Id: w.cc1, cc2Id: null, buId: null }]);
      await c.query('SAVEPOINT a');
      const intoB = await put(c, { cc2: w.cc2 }).then(() => 'ok', (e: { code?: string }) => e.code);
      await c.query('ROLLBACK TO SAVEPOINT a');
      const intoA = await put(c, { cc1: w.cc1 }).then(() => 'ok', (e: { code?: string }) => e.code);
      return { intoA, intoB };
    }));
    expect(out).toEqual({ intoA: 'ok', intoB: 'BV003' });
  });

  it('REPRO 7: resetting a driver override inside a slice with its reviewer is 409 BUDGET_SLICE_LOCKED and writes nothing', async () => {
    const { v } = await setup(false);
    // The owner overrides COGS/CC2 month 0 (their own cell, the reviewer path opens CC2), then clears the override.
    const o = await fx.call.save(w.u, v, [{ glAccountId: w.cogs, cc1Id: null, cc2Id: w.cc2, buId: null, month: w.months[0], amount: 999 }]);
    expect(o.status, dump(o)).toBe(200);
    const before = await fx.state(v);
    const r = await fx.call.save(w.u, v, [{ glAccountId: w.cogs, cc1Id: null, cc2Id: w.cc2, buId: null, month: w.months[0], amount: null, clear: true }]);
    expect([r.status, (r.body.error as { details?: { code?: string } })?.details?.code], dump(r)).toEqual([409, 'BUDGET_SLICE_LOCKED']);
    expect(String(r.body.error?.message)).toMatch(/Return the slice first/);
    expect(await fx.state(v)).toEqual(before);
    expect(await at(v, w.cogs, { cc2: w.cc2 }, w.months[0]!)).toBe('999.00');
  });
});
