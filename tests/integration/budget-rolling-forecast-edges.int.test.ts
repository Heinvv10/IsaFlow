/**
 * Budgets P4 rolling forecast, the edges PR-4's breaker round 1 found (spec §5, §6):
 *  1. a journal line naming a member no budget cell may name at that level (a CC1 centre retyped
 *     to CC2 since) is UNPLACED, never written: the reforecast is a 201 and the roll rolls;
 *  2. an auto roll's unplaced actuals stay visible in the status (recomputed, no migration) even when
 *     the roll changed no cell, and the roll audit lists the amounts, not a count;
 *  3. the status names a month reopened after the roll;
 *  4. a rolling version is never the primary (ruling 2026-10-29): auto-roll cannot be turned on for
 *     a primary; a rolling version made primary since is skipped ('version is primary', nothing
 *     changes, the token included; Roll now 409); an approved non-primary version still rolls;
 *  5. an auto roll that fails for another reason (a driver result beyond the budget range) records a
 *     fixed last_error and changes nothing, the token included; Roll now with no change answers the
 *     client's token in P1's form;
 * plus probes: an open-month override survives a roll; Roll now racing the toggle on one token is
 * one 200 and one 409 STALE; closing the year writes one roll audit row.
 *
 * Each test has its own company. The source: Sales 1 000 a month (company), Salaries 500 a month at
 * CC1 (labour budgeted by cost centre), COGS = 38% of Sales.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetReforecastFixture, type ReforecastWorld } from './helpers/budgetReforecastFixture';
import { dataOf, details, type RouteOut } from './helpers/budgetDriverRouteFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const fx = budgetReforecastFixture(pool);
const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`;

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

interface Unplaced { accountCode: string; month: string; amount: number; level: string }

async function source(w: ReforecastWorld): Promise<string> {
  const m = w.months;
  const s = await fx.version(w);
  for (const month of m) {
    await fx.amount(w, s, w.sales, month, 1000);
    await fx.amount(w, s, w.salaries, month, 500, { cc1: w.cc1 });
  }
  const put = await fx.call.drivers(w.u, 'PUT', {
    versionId: s, glAccountId: w.cogs, kind: 'pct_of_line', pct: 38, fromMonth: m[0], toMonth: m[11], ref: { glAccountId: w.sales },
  });
  expect(put.status, dump(put)).toBe(200);
  return s;
}

async function rolling(w: ReforecastWorld, s: string): Promise<string> {
  const r = await fx.call.reforecast(w.u, s, 'POST', { name: `Rolling-${crypto.randomUUID().slice(0, 6)}`, rolling: true });
  expect(r.status, dump(r)).toBe(201);
  return dataOf<{ version: { id: string } }>(r).version.id;
}

const status = async (w: ReforecastWorld, v: string) => {
  const r = await fx.call.reforecast(w.u, v, 'GET');
  expect(r.status, dump(r)).toBe(200);
  return dataOf<{ unplaced: Unplaced[]; reopenedMonths: string[]; rolledThroughMonth: string | null; lastError: string | null }>(r);
};

const makePrimary = async (w: ReforecastWorld, v: string) => {
  await pool.query('UPDATE budget_versions SET is_primary = false WHERE company_id = $1 AND fiscal_year = $2', [w.u.homeCompanyId, w.label]);
  await pool.query('UPDATE budget_versions SET is_primary = true WHERE id = $1', [v]);
};

describe('budget rolling forecast: edges', { timeout: 90000 }, () => {
  it('an actual on a centre retyped CC1 → CC2 is unplaced, never written: the reforecast is a 201 and the roll rolls', async () => {
    const w = await fx.world();
    const m = w.months;
    const s = await source(w);
    const rf = await rolling(w, s);
    const retyped = String((await pool.query(
      `INSERT INTO cost_centres (company_id, code, name, cc_type) VALUES ($1, 'GS-C1X', 'GS-C1X', 'cc1') RETURNING id`, [w.u.homeCompanyId])).rows[0].id);
    await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200], [w.salaries, 300, 0, { cc1: retyped }], [w.salaries, 100, 0, { cc1: w.cc1 }]]);
    // No budget amount or driver uses it, so the kind triggers allow the retype.
    await pool.query(`UPDATE cost_centres SET cc_type = 'cc2' WHERE id = $1`, [retyped]);
    await fx.close(w, [m[0]!]);
    await fx.until(async () => { const r = await fx.rollingRow(rf); return r?.through === m[0] || r?.last_error != null; }, 'the roll');
    expect(await fx.rollingRow(rf)).toMatchObject({ through: m[0], last_error: null });
    expect((await fx.cellsOf(rf, w.salaries, w.cc1)).get(m[0]!)).toBe('100.00:actual');
    expect((await fx.cellsOf(rf, w.salaries, retyped)).size).toBe(0);
    expect((await status(w, rf)).unplaced).toEqual([expect.objectContaining({ accountCode: 'GS-6500', month: m[0], amount: 300, level: 'cc1' })]);

    const r = await fx.call.reforecast(w.u, s, 'POST', { name: 'After retype' });
    expect(r.status, dump(r)).toBe(201);
    const made = dataOf<{ version: { id: string }; unplaced: Unplaced[] }>(r);
    expect(made.unplaced).toEqual([expect.objectContaining({ accountCode: 'GS-6500', month: m[0], amount: 300 })]);
    expect((await fx.cellsOf(made.version.id, w.salaries, retyped)).size).toBe(0);
  });

  it("an auto roll's unplaced actuals stay in the status after a roll that changed no cell; the audit lists the amounts", async () => {
    const w = await fx.world();
    const m = w.months;
    const rf = await rolling(w, await source(w));
    await fx.journal(w, `${m[0]}-15`, [[w.salaries, 300, 0, { cc1: w.cc1 }], [w.salaries, 200, 0]], { source: 'auto_payroll' });
    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === m[0], 'the first roll');
    expect((await fx.audits(rf)).at(-1)!.changes.metadata).toMatchObject({ rolled: 'auto', unplaced: `GS-6500 ${m[0]} 200.00` });
    expect((await status(w, rf)).unplaced).toEqual([expect.objectContaining({ accountCode: 'GS-6500', month: m[0], amount: 200 })]);
    // Reopen, post more untagged payroll, close again: the CC1 cells do not move, so the roll changes nothing.
    expect((await fx.call.period(w.u, { action: 'reopen', id: w.periods.get(m[0]!) })).status).toBe(200);
    await fx.journal(w, `${m[0]}-20`, [[w.salaries, 50, 0]], { source: 'auto_payroll' });
    const audits = (await fx.audits(rf)).length;
    const before = (await fx.rollingRow(rf))!.rolled_at;
    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.rolled_at !== before, 'the second roll');
    expect((await fx.audits(rf)).length).toBe(audits);
    expect((await status(w, rf)).unplaced).toEqual([expect.objectContaining({ accountCode: 'GS-6500', month: m[0], amount: 250 })]);
  });

  it('the status names a month reopened after the roll, until the next roll', async () => {
    const w = await fx.world();
    const m = w.months;
    const rf = await rolling(w, await source(w));
    await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200]]);
    await fx.close(w, [m[0]!, m[1]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === m[1], 'the roll through month 2');
    expect((await status(w, rf)).reopenedMonths).toEqual([]);
    expect((await fx.call.period(w.u, { action: 'reopen', id: w.periods.get(m[1]!) })).status).toBe(200);
    expect((await fx.call.period(w.u, { action: 'reopen', id: w.periods.get(m[0]!) })).status).toBe(200);
    expect((await fx.cellsOf(rf, w.sales)).get(m[0]!)).toBe('1200.00:actual');
    expect(await status(w, rf)).toMatchObject({ rolledThroughMonth: m[1], reopenedMonths: [m[0], m[1]] });
    const roll = await fx.call.reforecast(w.u, rf, 'POST', { action: 'roll', expectedUpdatedAt: await fx.token(rf) });
    expect(roll.status, dump(roll)).toBe(200);
    expect(await status(w, rf)).toMatchObject({ rolledThroughMonth: null, reopenedMonths: [] });
  });

  it('a rolling version is never the primary: the toggle refuses a primary, a roll skips one, an approved non-primary rolls', async () => {
    const w = await fx.world();
    const m = w.months;
    const s = await source(w);
    const rf = await rolling(w, s);
    await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200]]);

    // Approved, not primary: rolls (decision 2), audited.
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [rf, w.u.userId]);
    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === m[0], 'the approved roll');
    expect((await fx.cellsOf(rf, w.sales)).get(m[0]!)).toBe('1200.00:actual');

    // Made primary since: skipped, nothing changes (token included); Roll now is a 409.
    await makePrimary(w, rf);
    const cells = await fx.snapshot(rf);
    const token = await fx.token(rf);
    const rolledAt = (await fx.rollingRow(rf))!.rolled_at;
    await fx.call.period(w.u, { action: 'lock', id: w.periods.get(m[0]!) });
    await fx.until(async () => (await fx.rollingRow(rf))?.last_error === 'version is primary', 'the skipped roll');
    expect(await fx.rollingRow(rf)).toMatchObject({ through: m[0], rolled_at: rolledAt });
    expect(await fx.snapshot(rf)).toEqual(cells);
    expect(await fx.token(rf)).toBe(token);
    const now = await fx.call.reforecast(w.u, rf, 'POST', { action: 'roll', expectedUpdatedAt: token });
    expect([now.status, details(now).code], dump(now)).toEqual([409, 'BUDGET_VERSION_STATE']);
    expect(String(now.body.error?.message)).toMatch(/primary budget/);
    expect(await fx.snapshot(rf)).toEqual(cells);
    expect(await fx.token(rf)).toBe(token);

    // Auto-roll cannot be turned on for a primary.
    const off = await fx.call.reforecast(w.u, rf, 'PUT', { rolling: false, expectedUpdatedAt: token });
    expect(off.status, dump(off)).toBe(200);
    const on = await fx.call.reforecast(w.u, rf, 'PUT', { rolling: true, expectedUpdatedAt: await fx.token(rf) });
    expect([on.status, details(on).code], dump(on)).toEqual([409, 'BUDGET_VERSION_STATE']);
    expect(await fx.rollingRow(rf)).toBeUndefined();
  });

  it('an auto roll failing on a driver result beyond the range records a fixed last_error and changes nothing', async () => {
    const w = await fx.world();
    const m = w.months;
    const s = await source(w);
    // Rent x1000 a month from month 1's value: harmless while month 1 holds no actual (base 0).
    const put = await fx.call.drivers(w.u, 'PUT', {
      versionId: s, glAccountId: w.rent, kind: 'growth', pct: 99900, baseMonth: m[0], fromMonth: m[1], toMonth: m[11],
    });
    expect(put.status, dump(put)).toBe(200);
    const rf = await rolling(w, s);
    await fx.journal(w, `${m[0]}-15`, [[w.rent, 1000, 0]]);
    const cells = await fx.snapshot(rf);
    const token = await fx.token(rf);
    const created = await fx.rollingRow(rf);
    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.last_error != null, 'the failed roll');
    expect(await fx.rollingRow(rf)).toEqual({ ...created, last_error: 'a driver result is beyond the budget range' });
    expect(await fx.snapshot(rf)).toEqual(cells);
    expect(await fx.token(rf)).toBe(token);
  });

  it("Roll now with no change answers the client's token (proven by the compare-and-set) in P1's form", async () => {
    const w = await fx.world();
    const rf = await rolling(w, await source(w));
    const token = await fx.token(rf);
    // The same instant written as Postgres prints it at +02:00.
    const local = String((await pool.query(
      `SELECT to_char(updated_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI:SS.US') || '+02' AS t FROM budget_versions WHERE id = $1`,
      [rf])).rows[0].t);
    const r = await fx.call.reforecast(w.u, rf, 'POST', { action: 'roll', expectedUpdatedAt: local });
    expect(r.status, dump(r)).toBe(200);
    expect(dataOf(r)).toMatchObject({ changed: 0, updatedAt: token });
    expect(await fx.token(rf)).toBe(token);
  });

  it('turning auto-roll on stamps what the version already holds: through the closed months that hold actuals, else not rolled', async () => {
    const w = await fx.world();
    const m = w.months;
    const s = await source(w);
    await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200]]);
    await fx.close(w, [m[0]!]);
    const rf = await rolling(w, s);
    const toggle = async (v: string, on: boolean) => {
      const r = await fx.call.reforecast(w.u, v, 'PUT', { rolling: on, expectedUpdatedAt: await fx.token(v) });
      expect(r.status, dump(r)).toBe(200);
    };
    await toggle(rf, false);
    await toggle(rf, true);
    expect(await fx.rollingRow(rf)).toMatchObject({ through: m[0], rolled_at: expect.any(String) });
    expect(await status(w, rf)).toMatchObject({ rolledThroughMonth: m[0], staleMonths: [] });
    // A month closed while auto-roll was off holds no actual: it is stale, not rolled.
    await toggle(rf, false);
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE id = $1`, [w.periods.get(m[1]!)]);
    await toggle(rf, true);
    expect(await status(w, rf)).toMatchObject({ rolledThroughMonth: m[0], staleMonths: [m[1]] });
    // A reforecast made before any close, then turned on: its first closed month holds no actual, so not rolled yet.
    const early = await fx.call.reforecast(w.u, s, 'POST', { name: 'Not rolling' });
    expect(early.status, dump(early)).toBe(201);
    const v = dataOf<{ version: { id: string } }>(early).version.id;
    await pool.query(`UPDATE budget_month_amounts SET amount_source = 'manual' WHERE version_id = $1 AND amount_source = 'actual'`, [v]);
    await toggle(rf, false);
    await toggle(v, true);
    expect(await fx.rollingRow(v)).toMatchObject({ through: null, rolled_at: null });
    expect(await status(w, v)).toMatchObject({ rolledThroughMonth: null, staleMonths: [m[0], m[1]] });
  });

  it('probe: an override in an open month survives the auto roll', async () => {
    const w = await fx.world();
    const m = w.months;
    const rf = await rolling(w, await source(w));
    await pool.query(`UPDATE budget_month_amounts SET amount = 999, amount_source = 'override' WHERE version_id = $1 AND gl_account_id = $2 AND month = $3`,
      [rf, w.cogs, `${m[4]}-01`]);
    await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200]]);
    await fx.close(w, [m[0]!]);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === m[0], 'the roll');
    expect((await fx.cellsOf(rf, w.cogs)).get(m[4]!)).toBe('999.00:override');
  });

  it('probe: Roll now racing the toggle on one token is one 200 and one 409 STALE', async () => {
    const w = await fx.world();
    const m = w.months;
    const rf = await rolling(w, await source(w));
    await fx.journal(w, `${m[0]}-15`, [[w.sales, 0, 1200]]);
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE id = $1`, [w.periods.get(m[0]!)]);
    const token = await fx.token(rf);
    const [roll, toggle] = await Promise.all([
      fx.call.reforecast(w.u, rf, 'POST', { action: 'roll', expectedUpdatedAt: token }),
      fx.call.reforecast(w.u, rf, 'PUT', { rolling: true, expectedUpdatedAt: token }),
    ]);
    expect([roll.status, toggle.status].sort(), `${dump(roll)} ${dump(toggle)}`).toEqual([200, 409]);
    expect(details(roll.status === 409 ? roll : toggle).code).toBe('BUDGET_VERSION_STALE');
  });

  it('probe: closing the year writes exactly one roll audit row', async () => {
    const w = await fx.world();
    const rf = await rolling(w, await source(w));
    const n0 = (await fx.audits(rf)).length;
    const year = await fx.call.period(w.u, { action: 'close_year', fiscalYear: w.label });
    expect(year.status, dump(year)).toBe(200);
    await fx.until(async () => (await fx.rollingRow(rf))?.through === w.months[11], 'the year roll');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await fx.audits(rf)).slice(n0).filter((a) => a.changes.metadata?.rolled)).toHaveLength(1);
  });
});
