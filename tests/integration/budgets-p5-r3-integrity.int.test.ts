/**
 * Budgets P5-6 r3: write integrity of budget-holder slices in the database (migration 955), the
 * breaker's repros of PR #1119 brought in, each run AS app_user with a member's claims:
 * - REPRO 3: a holder rewrites another (approved) slice's driver line by SQL; planned hires the same;
 * - REPRO 4: a holder approves the draft version by SQL; the owner only with every slice approved, or
 *   forcing it (budget_version_force_begin; a hand-set GUC opens nothing for an admin);
 * - REPRO 5: a status move that also moves the due date, or a submit that carries a note;
 * - a submitted or approved slice's holders and their accounts do not change (DB and route);
 * - a company delete with claims set cascades through the slice rules.
 * (REPRO 1/2, reads, are by design: the holder view scopes work, it is not access control.)
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, type DriverWorld, type RouteOut } from './helpers/budgetDriverRouteFixture';
import { budgetHoldersFixture, errCodeOf } from './helpers/budgetHoldersFixture';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import holdersRoute from '../../pages/api/accounting/budgets/holders';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
const hx = budgetHoldersFixture(pool, saveRoute);
let w: DriverWorld;
let holder: SetupUser;
let holderB: SetupUser;
let admin: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  holder = await fx.member(w.u.homeCompanyId, 'manager');
  holderB = await fx.member(w.u.homeCompanyId, 'manager');
  admin = await fx.member(w.u.homeCompanyId, 'admin');
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

const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`;
const cell = (glAccountId: string, month: string, amount: number) => ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount });
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
const as = <T>(u: SetupUser, fn: (c: PoolClient) => Promise<T>, commit = false) => hx.asMember(u, fn, commit);

/** V: holder holds CC1; holderB holds CC2 (rent 777 there). */
async function setup(): Promise<{ v: string; sliceA: string; sliceB: string }> {
  const v = await fx.version(w);
  await fx.amount(w, v, w.rent, w.months[0]!, 777, { cc2: w.cc2 });
  await fx.amount(w, v, w.child1, w.months[0]!, 11, { cc1: w.cc1 });
  const sliceA = await hx.hold(w as never, v, holder.userId, { cc1: w.cc1 });
  const sliceB = await hx.hold(w as never, v, holderB.userId, { cc2: w.cc2 });
  return { v, sliceA, sliceB };
}

describe('REPRO 3: driver lines and planned hires follow the slice rules', () => {
  it('a holder cannot rewrite an approved slice\'s driver; the owner\'s next save leaves the approved slice as approved', async () => {
    const { v, sliceB } = await setup();
    const put = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, cc2Id: w.cc2, kind: 'fixed', amount: 500, fromMonth: w.months[1], toMonth: w.months[2],
    });
    expect(put.status, dump(put)).toBe(200);
    await hx.setStatus(sliceB, 'submitted', holderB.userId);
    await hx.setStatus(sliceB, 'approved', w.u.userId);
    expect(await code(as(holder, (c) => c.query('UPDATE budget_driver_lines SET amount = 99999 WHERE version_id = $1 AND cc2_id = $2', [v, w.cc2]), true)))
      .toBe('BV004');
    // Nor the owner off the reviewer path (the driver routes), nor anyone deleting it.
    expect(await code(as(w.u, (c) => c.query('UPDATE budget_driver_lines SET amount = 99999 WHERE version_id = $1 AND cc2_id = $2', [v, w.cc2]))))
      .toBe('BV003');
    const s = await fx.call.save(w.u, v, [cell(w.sales, w.months[3]!, 123)]);
    expect(s.status, dump(s)).toBe(200);
    const b = (await pool.query(
      `SELECT amount::text FROM budget_month_amounts WHERE version_id = $1 AND gl_account_id = $2 AND cc2_id = $3 AND month = ($4 || '-01')::date`,
      [v, w.rent, w.cc2, w.months[1]])).rows[0]?.amount;
    expect(b).toBe('500.00');
    // The owner's driver route into the approved slice: a 409 naming the driver.
    const owner = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, cc2Id: w.cc2, kind: 'fixed', amount: 600, fromMonth: w.months[1], toMonth: w.months[2],
    });
    expect([owner.status, errCodeOf(owner as never)], dump(owner)).toEqual([409, 'BUDGET_SLICE_DRIVER']);
    expect(String(owner.body.error?.message)).toMatch(/driver on BR-5000 Rent \(CC2\) is in a slice already approved/);
  });

  it('planned hires: a holder only on their slice\'s centre; nobody off the reviewer path on a slice with its reviewer', async () => {
    const { v, sliceB } = await setup();
    const hire = (c: PoolClient, cc: string | null) => c.query(
      `INSERT INTO budget_planned_hires (company_id, version_id, label, cost_centre_id, start_month, fte, created_by)
       VALUES ($1, $2, 'Analyst', $3, ($4 || '-01')::date, 1, 'x')`, [w.u.homeCompanyId, v, cc, w.months[2]]);
    expect(await code(as(holder, (c) => hire(c, w.cc1)))).toBe('ok');
    expect(await code(as(holder, (c) => hire(c, w.cc2)))).toBe('BV004');
    expect(await code(as(holder, (c) => hire(c, null)))).toBe('BV004');
    await hx.setStatus(sliceB, 'submitted', holderB.userId);
    expect(await code(as(holderB, (c) => hire(c, w.cc2)))).toBe('BV003');
    expect(await code(as(w.u, (c) => hire(c, w.cc2)))).toBe('BV003');
    expect(await code(as(w.u, async (c) => {
      await c.query('SELECT public.budget_slice_review_begin($1, $2)', [w.u.homeCompanyId, v]);
      await hire(c, w.cc2);
    }))).toBe('ok');
  });
});

describe('REPRO 4: approving the version in the database', () => {
  const approve = (c: PoolClient, v: string, by: string) =>
    c.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [v, by]);

  it('a holder (manager) is refused; the owner and admin only with every slice approved; the owner forces with the helper', async () => {
    const { v, sliceA, sliceB } = await setup();
    expect(await code(as(holder, (c) => approve(c, v, holder.userId)))).toBe('BV004');
    expect(await code(as(w.u, (c) => approve(c, v, w.u.userId)))).toBe('BV006');
    // A GUC set by hand opens nothing for an admin (the role is re-checked); the owner's helper does.
    expect(await code(as(admin, async (c) => {
      await c.query("SELECT set_config('budgets.version_force_approve', $1, true)", [`${w.u.homeCompanyId}:${v}`]);
      await approve(c, v, admin.userId);
    }))).toBe('BV006');
    expect(await code(as(admin, (c) => c.query('SELECT public.budget_version_force_begin($1, $2)', [w.u.homeCompanyId, v])))).toBe('BV004');
    expect(await code(as(w.u, async (c) => {
      await c.query('SELECT public.budget_version_force_begin($1, $2)', [w.u.homeCompanyId, v]);
      await approve(c, v, w.u.userId);
    }))).toBe('ok');
    for (const [s, h] of [[sliceA, holder], [sliceB, holderB]] as const) {
      await hx.setStatus(s, 'submitted', h.userId);
      await hx.setStatus(s, 'approved', w.u.userId);
    }
    expect(await code(as(admin, (c) => approve(c, v, admin.userId)))).toBe('ok');
  });
});

describe('REPRO 5: a status move moves nothing else', () => {
  it('a submit that sets the due date or carries a note is refused; the plain submit is not', async () => {
    const { sliceA } = await setup();
    const move = (sql: string) => code(as(holder, (c) => c.query(sql, [sliceA])));
    expect(await move(`UPDATE budget_slice_reviews SET status = 'submitted', due_date = '2099-01-01' WHERE id = $1`)).toBe('BV005');
    expect(await move(`UPDATE budget_slice_reviews SET status = 'submitted', decision_note = 'approved by me' WHERE id = $1`)).toBe('BV005');
    expect(await move(`UPDATE budget_slice_reviews SET status = 'submitted' WHERE id = $1`)).toBe('ok');
  });
});

describe('a slice with its reviewer keeps its holders and accounts', () => {
  it('the route answers 409; the database refuses (BV003) a new holder, an account change, a removal', async () => {
    const { v, sliceA } = await setup();
    await hx.setStatus(sliceA, 'submitted', holder.userId);
    const r = await hx.call(holdersRoute, w.u, 'POST', { body: { versionId: v, userId: holder.userId, cc1Id: w.cc1, glAccountIds: [w.child1] } });
    expect([r.status, errCodeOf(r)], dump(r)).toEqual([409, 'BUDGET_SLICE_STATE']);
    expect(await code(as(w.u, (c) => c.query(`UPDATE budget_holders SET gl_account_ids = ARRAY[$2]::uuid[] WHERE version_id = $1 AND cc1_id = $3`,
      [v, w.child1, w.cc1])))).toBe('BV003');
    expect(await code(as(w.u, (c) => c.query(`INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, created_by) VALUES ($1, $2, $3, $4, 'x')`,
      [w.u.homeCompanyId, v, holderB.userId, w.cc1])))).toBe('BV003');
    expect(await code(as(w.u, (c) => c.query('DELETE FROM budget_holders WHERE version_id = $1 AND cc1_id = $2', [v, w.cc1])))).toBe('BV003');
  });
});

describe('a company delete cascades through the slice rules', () => {
  it('with a session user\'s claims set (not a member), the company and its versions, holders and slice reviews go', async () => {
    const co = crypto.randomUUID();
    const owner = crypto.randomUUID();
    const mgr = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [co, 'P5-6 delete']);
    for (const u of [owner, mgr, stranger]) await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [u, `${u}@test.local`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'manager')`, [co, owner, mgr]);
    // No account (gl_accounts does not cascade from a company: a purge removes them first).
    const v = (await pool.query(`INSERT INTO budget_versions (company_id, fiscal_year, name, kind, created_by) VALUES ($1, 2027, 'Doomed', 'scenario', $2) RETURNING id`,
      [co, owner])).rows[0].id;
    await pool.query(`INSERT INTO budget_holders (company_id, version_id, user_id, created_by) VALUES ($1, $2, $3, 'x')`, [co, v, mgr]);
    const slice = (await pool.query(`INSERT INTO budget_slice_reviews (company_id, version_id, created_by) VALUES ($1, $2, 'x') RETURNING id`, [co, v])).rows[0].id;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: mgr })]);
      await c.query(`UPDATE budget_slice_reviews SET status = 'submitted' WHERE id = $1`, [slice]);
      await c.query('COMMIT');
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: stranger })]);
      await c.query('DELETE FROM companies WHERE id = $1', [co]);
      await c.query('COMMIT');
      expect((await pool.query('SELECT COUNT(*)::int n FROM budget_slice_reviews WHERE company_id = $1', [co])).rows[0].n).toBe(0);
      expect((await pool.query('SELECT COUNT(*)::int n FROM companies WHERE id = $1', [co])).rows[0].n).toBe(0);
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
      await pool.query('DELETE FROM budget_slice_reviews WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM budget_holders WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM budget_versions WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [co]);
      await pool.query('DELETE FROM companies WHERE id = $1', [co]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[owner, mgr, stranger]]);
    }
  });
});
