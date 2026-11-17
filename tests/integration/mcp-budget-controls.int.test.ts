/**
 * MCP budget tools PR 3 against a real database, through the real registry as app_user:
 *  - what restore_budget_version covers: an amount write is restored while the drivers are untouched; a
 *    set_budget_drivers write is never restored; an amount write is refused once the drivers changed after it
 *    (an app driver edit in a later request: refused naming the drivers, before the token check);
 *  - budget_remaining and budget_tracking answer what the app's remaining-budget preview and alerts list answer
 *    (the same figures, as decimal text), for the roles the app admits.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import remainingRoute from '../../pages/api/accounting/budgets/remaining';
import alertsRoute from '../../pages/api/accounting/budgets/alerts/index';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, dataOf, type DriverWorld } from './helpers/budgetDriverRouteFixture';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';
import { body, mcp, mcpReads, text } from './helpers/mcpBudgetFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
const reads = mcpReads(pool);
const remaining = budgetsRouteFixture(pool, remainingRoute, '/api/accounting/budgets/remaining');
const alerts = budgetsRouteFixture(pool, alertsRoute, '/api/accounting/budgets/alerts');

let w: DriverWorld;
let manager: SetupUser;
beforeAll(async () => {
  w = await fx.world();
  manager = await fx.member(w.u.homeCompanyId, 'manager');
}, 120_000);
afterAll(async () => {
  try {
    for (const t of ['mcp_tool_calls', 'budget_alerts']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120_000);

const key = () => crypto.randomUUID();
const amount = (v: string, month: string, value: string) =>
  mcp(pool, w.u, 'set_budget_amounts', { version_id: v, cells: [{ account: 'BR-5000', month, amount: value }], idempotency_key: key() });
const restoreDry = (v: string) => mcp(pool, w.u, 'restore_budget_version', { version_id: v, dry_run: true, idempotency_key: key() });

describe('what restore_budget_version covers', () => {
  it('an amount write with the drivers untouched is restored', async () => {
    const v = await fx.version(w);
    body(await amount(v, w.months[0]!, '10.00'));
    expect(body(await restoreDry(v))).toMatchObject({ dry_run: true, cells: 1 });
  });

  it('a set_budget_drivers write is never restored (its snapshot records the cells it changed)', async () => {
    const v = await fx.version(w);
    for (const m of w.months.slice(0, 3)) await fx.amount(w, v, w.sales, m, 1000);
    body(await amount(v, w.months[0]!, '10.00'));
    const changes = [{ op: 'set_driver', account: 'GS-5100', kind: 'pct_of_line', pct: 38, from_month: w.months[0], to_month: w.months[11], ref: { account: 'GS-4000' } }];
    const d = body(await mcp(pool, w.u, 'set_budget_drivers', { version_id: v, changes, dry_run: true, idempotency_key: key() }));
    body(await mcp(pool, w.u, 'set_budget_drivers', { version_id: v, changes, plan_hash: d.plan_hash, idempotency_key: key() }));
    const before = await fx.state(v);
    expect(text(await restoreDry(v))).toMatch(/was set_budget_drivers: restore_budget_version undoes amount writes only/);
    expect(text(await mcp(pool, w.u, 'restore_budget_version', { version_id: v, idempotency_key: key() }))).toMatch(/was set_budget_drivers/);
    expect(await fx.state(v)).toEqual(before);
    expect((await reads.snapshots(v)).map((s) => [s.tool, s.restored_at])).toEqual([['set_budget_amounts', null], ['set_budget_drivers', null]]);
  });

  it('an amount write followed by an app driver edit (a later request) is refused, naming the drivers', async () => {
    const v = await fx.version(w);
    body(await amount(v, w.months[0]!, '10.00'));
    const put = await fx.call.drivers(w.u, 'PUT', { versionId: v, glAccountId: w.child1, kind: 'fixed', amount: 5, fromMonth: w.months[4], toMonth: w.months[5] });
    expect(put.status).toBe(200);
    const before = await fx.state(v);
    expect(text(await restoreDry(v))).toMatch(/The drivers of this version changed since that write/);
    expect(await fx.state(v)).toEqual(before);
  });
});

describe('the control reads answer what the app answers', () => {
  it('budget_remaining = POST budgets/remaining (a manager), as decimal text', async () => {
    const v = await fx.version(w, { primary: true });
    await fx.amount(w, v, w.rent, w.months[0]!, 1234.56);
    await fx.amount(w, v, w.child1, w.months[0]!, 50, { cc1: w.cc1 });
    const lines = [{ glAccountId: w.rent, month: w.months[0] }, { glAccountId: w.child1, cc1Id: w.cc1, month: w.months[0] }, { glAccountId: w.child1, month: w.months[0] }];
    const ui = await remaining.call(manager, 'POST', { lines });
    expect(ui.status, JSON.stringify(ui.body).slice(0, 300)).toBe(200);
    const app = dataOf<{ lines: Array<{ budget: number | null; actual: number; committed: number; remaining: number | null; offSlice: boolean; unassigned: boolean; grain: string | null }> }>(ui).lines;
    const out = body(await mcp(pool, manager, 'budget_remaining', { lines: [
      { account: 'BR-5000', month: w.months[0] }, { account: 'GS-6100', cc1: 'GS-C1', month: w.months[0] }, { account: 'GS-6100', month: w.months[0] },
    ] }, { role: 'manager', scopes: ['read:reports'] }));
    const money = (x: number | null) => (x === null ? null : x.toFixed(2));
    expect((out.lines as Array<Record<string, unknown>>).map((l) => [l.budget, l.actual, l.committed, l.remaining, l.off_slice, l.unassigned, l.grain]))
      .toEqual(app.map((l) => [money(l.budget), money(l.actual), money(l.committed), money(l.remaining), l.offSlice, l.unassigned, l.grain]));
    expect(app[0]!.budget).toBe(1234.56);
    expect(app[2]!.budget).toBeNull();
  });

  it('budget_tracking = GET budgets/alerts (an owner); a manager is refused by both', async () => {
    const v = await fx.version(w);
    await pool.query(
      `INSERT INTO budget_alerts (company_id, version_id, gl_account_id, month, threshold, budget, actual, committed, pct)
       VALUES ($1, $2, $3, $4, 100, 1000, 1200.5, 0, 120.05), ($1, $2, $3, $5, 80, 0, 10, 0, 'Infinity')`,
      [w.u.homeCompanyId, v, w.rent, `${w.months[0]}-01`, `${w.months[1]}-01`]);
    const ui = await alerts.call(w.u, 'GET');
    expect(ui.status).toBe(200);
    const app = dataOf<{ open: Array<{ id: string; budget: number; actual: number; pct: number | null; threshold: number; month: string }> }>(ui).open;
    const out = body(await mcp(pool, w.u, 'budget_tracking', {}, { scopes: ['read:reports'] }));
    expect((out.items as Array<Record<string, unknown>>).map((a) => [a.id, a.month, a.threshold, a.budget, a.actual, a.pct]))
      .toEqual(app.map((a) => [a.id, a.month, a.threshold, a.budget.toFixed(2), a.actual.toFixed(2), a.pct]));
    expect(app.map((a) => a.pct)).toEqual(expect.arrayContaining([null, 120.05]));
    expect((await alerts.call(manager, 'GET')).status).toBe(403);
    expect(text(await mcp(pool, manager, 'budget_tracking', {}, { role: 'manager', scopes: ['read:reports'] }))).toMatch(/only by the owner and admin roles/);
  });
});
