/**
 * Budgets P4 rolling forecast (spec §6, §9 `budget-rolling-forecast`): a real closePeriod (the
 * fiscal-period route, through withAuth) rolls the company's rolling reforecast AFTER COMMIT; a
 * second roll changes no cell (each cell's xmin and updated_at stay); a locked rolling version is
 * skipped with last_error 'version locked' and its cells unchanged; Roll now with a stale token is
 * a 409; a month reopened after a roll becomes 'manual' (value kept) on the next roll and the
 * driver covering it recomputes; the status reports months closed since a roll that did not run;
 * closing the whole year rolls too.
 *
 * Each test has its own company. The source: Sales 1 000 a month, COGS = 38% of Sales. The ledger:
 * Sales 1 200 and COGS 400 in month 1, Sales 1 500 in month 2. Expected by hand: after month 1
 * closes, Sales 1 200 / COGS 400 'actual' there, every other month as the source (1 000 manual,
 * 380 driver); reopened, Sales 1 200 'manual' and COGS 38% × 1 200 = 456 'driver'.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetReforecastFixture, type ReforecastWorld } from './helpers/budgetReforecastFixture';
import { dataOf, details, type RouteOut } from './helpers/budgetDriverRouteFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetReforecastFixture(pool);
const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`;

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

/** A company with the source, its ledger, and a rolling reforecast created before any month closed. */
async function rollingWorld(): Promise<{ w: ReforecastWorld; m: string[]; rf: string }> {
  const w = await fx.world();
  const m = w.months;
  const source = await fx.version(w);
  for (const month of m) await fx.amount(w, source, w.sales, month, 1000);
  const put = await fx.call.drivers(w.u, 'PUT', {
    versionId: source, glAccountId: w.cogs, kind: 'pct_of_line', pct: 38, fromMonth: m[0], toMonth: m[11], ref: { glAccountId: w.sales },
  });
  expect(put.status, dump(put)).toBe(200);
  await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200], [w.cogs, 400, 0]]);
  await fx.journal(w, `${m[1]}-15`, [[w.sales, 0, 1500]]);
  const r = await fx.call.reforecast(w.u, source, 'POST', { name: 'Rolling', rolling: true });
  expect(r.status, dump(r)).toBe(201);
  const rf = dataOf<{ version: { id: string } }>(r).version.id;
  return { w, m, rf };
}

const values = async (v: string, acct: string) => [...(await fx.cellsOf(v, acct)).values()];
const rollNow = async (w: ReforecastWorld, v: string, token?: string) =>
  fx.call.reforecast(w.u, v, 'POST', { action: 'roll', expectedUpdatedAt: token ?? await fx.token(v) });

describe('budget rolling forecast', { timeout: 60000 }, () => {
  it('a real period close rolls the rolling version after commit; a second roll writes no cell', async () => {
    const { w, m, rf } = await rollingWorld();
    expect(await values(rf, w.sales)).toEqual(Array(12).fill('1000.00:manual'));
    const auditsBefore = (await fx.audits(rf)).length;

    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === m[0], 'the after-close roll');
    expect(await values(rf, w.sales)).toEqual(['1200.00:actual', ...Array(11).fill('1000.00:manual')]);
    expect(await values(rf, w.cogs)).toEqual(['400.00:actual', ...Array(11).fill('380.00:driver')]);
    expect(await fx.rollingRow(rf)).toMatchObject({ last_error: null });
    const audits = await fx.audits(rf);
    expect(audits.length).toBe(auditsBefore + 1);
    expect(audits.at(-1)!.changes.metadata).toMatchObject({ rolled: 'auto', closedMonths: m[0], cells: '2', headcountAsOf: 'none' });

    const before = await fx.snapshot(rf);
    const again = await rollNow(w, rf);
    expect(again.status, dump(again)).toBe(200);
    expect(dataOf(again)).toMatchObject({ status: 'rolled', changed: 0, rolledThroughMonth: m[0] });
    expect(await fx.snapshot(rf)).toEqual(before);
    expect((await fx.audits(rf)).length).toBe(auditsBefore + 1);
    expect(dataOf<{ updatedAt: string }>(again).updatedAt).toBe(await fx.token(rf));
  });

  it("a locked rolling version is skipped: last_error 'version locked', its cells unchanged; Roll now is 409 LOCKED", async () => {
    const { w, m, rf } = await rollingWorld();
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [rf, w.u.userId]);
    await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [rf, w.u.userId]);
    const before = await fx.snapshot(rf);
    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.last_error === 'version locked', 'the skipped roll');
    expect(await fx.snapshot(rf)).toEqual(before);
    expect(await fx.rollingRow(rf)).toMatchObject({ through: null, rolled_at: null });
    const r = await rollNow(w, rf);
    expect([r.status, details(r).code], dump(r)).toEqual([409, 'BUDGET_VERSION_LOCKED']);
    expect(await fx.snapshot(rf)).toEqual(before);
  });

  it('Roll now with a stale token is a 409 STALE with the current token, and writes nothing', async () => {
    const { w, m, rf } = await rollingWorld();
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE id = $1`, [w.periods.get(m[0]!)]);
    const before = await fx.snapshot(rf);
    const current = await fx.token(rf);
    const r = await rollNow(w, rf, '2020-01-01T00:00:00.000000Z');
    expect([r.status, details(r).code], dump(r)).toEqual([409, 'BUDGET_VERSION_STALE']);
    expect(details(r).currentUpdatedAt).toBe(current);
    expect(await fx.snapshot(rf)).toEqual(before);
    expect(await fx.rollingRow(rf)).toMatchObject({ through: null, rolled_at: null });
  });

  it("a month reopened after a roll becomes 'manual' on the next roll, value kept, and the driver covering it recomputes", async () => {
    const { w, m, rf } = await rollingWorld();
    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === m[0], 'the after-close roll');
    const reopen = await fx.call.period(w.u, { action: 'reopen', id: w.periods.get(m[0]!) });
    expect(reopen.status, dump(reopen)).toBe(200);
    // Reopening does not roll: the actual stays until the next roll.
    expect((await fx.cellsOf(rf, w.sales)).get(m[0]!)).toBe('1200.00:actual');
    const r = await rollNow(w, rf);
    expect(r.status, dump(r)).toBe(200);
    expect(dataOf(r)).toMatchObject({ changed: 2, rolledThroughMonth: null, closedMonths: [] });
    expect((await fx.cellsOf(rf, w.sales)).get(m[0]!)).toBe('1200.00:manual');
    expect((await fx.cellsOf(rf, w.cogs)).get(m[0]!)).toBe('456.00:driver');
    expect(await fx.rollingRow(rf)).toMatchObject({ through: null, last_error: null });
  });

  it('the status reports months closed since a roll that did not run; closing the year rolls through its last month', async () => {
    const { w, m, rf } = await rollingWorld();
    const status = async () => dataOf<Record<string, unknown>>(await fx.call.reforecast(w.u, rf, 'GET'));
    expect(await status()).toMatchObject({ rolling: true, rolledThroughMonth: null, latestClosedMonth: null, staleMonths: [] });
    // Closed outside the app (no after-commit roll), as after a lost job.
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE id = ANY($1::UUID[])`, [[w.periods.get(m[0]!), w.periods.get(m[1]!)]]);
    expect(await status()).toMatchObject({ rolling: true, rolledThroughMonth: null, latestClosedMonth: m[1], staleMonths: [m[0], m[1]] });

    const year = await fx.call.period(w.u, { action: 'close_year', fiscalYear: w.label });
    expect(year.status, dump(year)).toBe(200);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === m[11], 'the after-close-year roll');
    expect(await status()).toMatchObject({ rolledThroughMonth: m[11], latestClosedMonth: m[11], staleMonths: [], lastError: null });
    expect(await values(rf, w.sales)).toEqual(['1200.00:actual', '1500.00:actual', ...Array(10).fill('0.00:actual')]);
  });

  it('auto-roll toggles off and on under the token; only a reforecast can roll', async () => {
    const { w, rf } = await rollingWorld();
    const off = await fx.call.reforecast(w.u, rf, 'PUT', { rolling: false, expectedUpdatedAt: await fx.token(rf) });
    expect(off.status, dump(off)).toBe(200);
    expect(dataOf(off)).toMatchObject({ rolling: false, changed: true });
    expect(await fx.rollingRow(rf)).toBeUndefined();
    const notRolling = await rollNow(w, rf);
    expect([notRolling.status, details(notRolling).code], dump(notRolling)).toEqual([409, 'BUDGET_VERSION_STATE']);
    const on = await fx.call.reforecast(w.u, rf, 'PUT', { rolling: true, expectedUpdatedAt: await fx.token(rf) });
    expect(dataOf(on)).toMatchObject({ rolling: true, changed: true });
    expect(await fx.rollingRow(rf)).toMatchObject({ through: null });
    const scenario = await fx.version(w);
    const refused = await fx.call.reforecast(w.u, scenario, 'PUT', { rolling: true, expectedUpdatedAt: await fx.token(scenario) });
    expect([refused.status, details(refused).code], dump(refused)).toEqual([409, 'BUDGET_VERSION_STATE']);
    expect(await fx.rollingRow(scenario)).toBeUndefined();
  });
});
