/**
 * Budgets P5-6 r2: budget drivers and holder slices. A recompute that would write a driver's cells
 * outside the writer's reach is refused by the service BEFORE any driver cell is written, with a 409
 * naming the driver (BUDGET_SLICE_DRIVER), never the trigger's generic refusal:
 * - a holder's grid save whose driver recompute lands outside their slices;
 * - an owner's driver edit (the driver routes take no reviewer path) into a slice with its reviewer.
 * The owner's grid save (the reviewer path) still recomputes into it. Nothing changes on a refusal.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, type DriverWorld, type RouteOut } from './helpers/budgetDriverRouteFixture';
import { errCode } from './helpers/budgetGridSaveFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
let w: DriverWorld;
let holder: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
}, 120_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM budget_slice_reviews WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM budget_holders WHERE company_id = $1', [w.u.homeCompanyId]);
    await pool.query('DELETE FROM user_notifications WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120_000);

const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const cell = (glAccountId: string, month: string, amount: number) => ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount });

/** The company-level slice of `v`, held by the holder (optionally only `accounts`); returns the review id. */
async function companySlice(v: string, accounts: string[] | null): Promise<string> {
  await pool.query(`INSERT INTO budget_holders (company_id, version_id, user_id, gl_account_ids, created_by) VALUES ($1, $2, $3, $4, 'x')`,
    [w.u.homeCompanyId, v, holder.userId, accounts]);
  return String((await pool.query(`INSERT INTO budget_slice_reviews (company_id, version_id, created_by) VALUES ($1, $2, 'x') RETURNING id`,
    [w.u.homeCompanyId, v])).rows[0].id);
}
async function submit(slice: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: holder.userId })]);
    await c.query(`UPDATE budget_slice_reviews SET status = 'submitted' WHERE id = $1`, [slice]);
    await c.query('COMMIT');
  } finally { c.release(); }
}

describe('driver recomputes and holder slices', () => {
  it('a holder\'s save that makes a driver recompute outside their slice: 409 naming the driver, nothing written', async () => {
    const { v } = await fx.cogsOfSales(w);
    await companySlice(v, [w.sales]);
    const before = await fx.state(v);
    const r = await fx.call.save(holder, v, [cell(w.sales, w.months[0]!, 2000)]);
    expect([r.status, errCode(r)], dump(r)).toEqual([409, 'BUDGET_SLICE_DRIVER']);
    expect(String(r.body.error?.message)).toMatch(/driver on GS-5100 Cost of sales .*outside your budget slices/);
    expect(await fx.state(v)).toEqual(before);
  });

  it('an owner\'s driver edit into a slice with its reviewer: 409 naming the driver and the slice; the owner\'s grid save (reviewer path) recomputes into it', async () => {
    const { v } = await fx.cogsOfSales(w);
    await submit(await companySlice(v, null));
    const before = await fx.state(v);
    const r = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.cogs, kind: 'pct_of_line', pct: 40, fromMonth: w.months[0], toMonth: w.months[11], ref: { glAccountId: w.sales },
    });
    expect([r.status, errCode(r)], dump(r)).toEqual([409, 'BUDGET_SLICE_DRIVER']);
    expect(String(r.body.error?.message)).toMatch(/driver on GS-5100 Cost of sales .*submitted for review/);
    expect(await fx.state(v)).toEqual(before);
    const save = await fx.call.save(w.u, v, [cell(w.sales, w.months[0]!, 2000)]);
    expect(save.status, dump(save)).toBe(200);
    expect((await fx.row(v, w.cogs)).get(w.months[0]!)?.amount).toBe('760.00');
  });
});
