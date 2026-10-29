/**
 * Budgets P4 reforecast from actuals (spec §5, §9 `budget-reforecast-actuals`, §11): POST
 * /api/accounting/budget-versions/[id]/reforecast as a real owner, after real posted journals and
 * real period closes (the fiscal-period route's closePeriod).
 *
 * The source: Sales 1 000 a month (company level), Salaries 500 a month at CC1 (labour budgeted by
 * cost centre), COGS = 38% of Sales, Rent growing 10% a month from April's value (from May),
 * Stationery at R100 a head (company headcount), one planned hire from month 4 through the route
 * and a second from month 6 written directly (so the source's per-head cells are stale: a
 * reforecast refreshes headcount, nothing is frozen). The ledger (March and April closed, May open):
 *   March  Sales 1 200 untagged + 100 tagged CC1 (Sales is budgeted at company level: 1 300);
 *          COGS 400; Salaries 300 at CC1, 150 at the second CC1 (a member the source never budgeted),
 *          and 200 untagged posted by payroll ('auto_payroll' carries no CC1, as on dev 2026-10-29);
 *          Rent 40; a DRAFT journal of 5 000 Sales (not an actual).
 *   April  Sales 1 500; Rent 50; Salaries 250 untagged by payroll.
 *   May    Sales 999 (an open month: never an actual).
 * Expected, by hand: Sales 1 300 / 1 500 actual then 1 000 manual; COGS 400 / 0 actual then 380
 * driver; Salaries CC1 300 / 0 actual then 500 manual; second CC1 150 / 0 actual (new row, closed
 * months only); Rent 40 / 50 actual, then 55, 61 (60.50 → R61) driver; Stationery 0 / 0 actual, 0
 * in month 3, 100 in months 4-5 and 200 from month 6 (the source still holds 100 there); unplaced Salaries 200 (March)
 * and 250 (April). Closed-month cells equal P3's actuals reader at each grain, and the BvA report's
 * actual per account and month equals the cells plus the unplaced amount, to the cent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetReforecastFixture, type ReforecastWorld } from './helpers/budgetReforecastFixture';
import { dataOf, details, type RouteOut } from './helpers/budgetDriverRouteFixture';
import { asRequest } from './helpers/budgetTrackingFixture';
import { readTrackingActuals } from '../../src/modules/accounting/services/budgets/tracking/trackingActualRead';
import { buildBudgetTrackingReport } from '../../src/modules/accounting/services/budgets/tracking/budgetTrackingService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetReforecastFixture(pool);
let w: ReforecastWorld;
let source: string;
let m: string[];
const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`;

interface Created {
  version: { id: string; kind: string; status: string; basedOnVersionId: string; updatedAt: string };
  rolling: boolean; closedMonths: string[]; cells: number; headcountAsOf: string | null;
  warnings: Array<{ code: string; message: string }>;
  unplaced: Array<{ accountId: string; accountCode: string; accountName: string; level: string; month: string; amount: number }>;
}

beforeAll(async () => {
  w = await fx.world();
  m = w.months;
  source = await fx.version(w);
  for (const month of m) {
    await fx.amount(w, source, w.sales, month, 1000);
    await fx.amount(w, source, w.salaries, month, 500, { cc1: w.cc1 });
  }
  const cogs = await fx.call.drivers(w.u, 'PUT', {
    versionId: source, glAccountId: w.cogs, kind: 'pct_of_line', pct: 38, fromMonth: m[0], toMonth: m[11], ref: { glAccountId: w.sales },
  });
  expect(cogs.status, dump(cogs)).toBe(200);
  const rent = await fx.call.drivers(w.u, 'PUT', {
    versionId: source, glAccountId: w.rent, kind: 'growth', pct: 10, baseMonth: m[1], fromMonth: m[2], toMonth: m[11],
  });
  expect(rent.status, dump(rent)).toBe(200);
  const hire = await fx.call.hires(w.u, 'POST', { versionId: source, label: 'Sales rep', startMonth: m[3], fte: 1 });
  expect(hire.status, dump(hire)).toBe(200);
  const perHead = await fx.call.drivers(w.u, 'PUT', {
    versionId: source, glAccountId: w.child1, kind: 'per_head', amount: 100, headcountCostCentreId: null, fromMonth: m[0], toMonth: m[11],
  });
  expect(perHead.status, dump(perHead)).toBe(200);
  // A hire the source's cells never saw (no recompute): the reforecast must read it.
  await pool.query(
    `INSERT INTO budget_planned_hires (company_id, version_id, label, start_month, fte, created_by) VALUES ($1, $2, 'Engineer', $3, 1, $4)`,
    [w.u.homeCompanyId, source, `${m[5]}-01`, w.u.userId]);

  await fx.journal(w, `${m[0]}-15`, [
    [w.sales, 0, 1200], [w.sales, 0, 100, { cc1: w.cc1 }], [w.cogs, 400, 0],
    [w.salaries, 300, 0, { cc1: w.cc1 }], [w.salaries, 150, 0, { cc1: w.cc1b }], [w.rent, 40, 0],
  ]);
  await fx.journal(w, `${m[0]}-25`, [[w.salaries, 200, 0]], { source: 'auto_payroll' });
  await fx.journal(w, `${m[0]}-20`, [[w.sales, 0, 5000]], { status: 'draft' });
  await fx.journal(w, `${m[1]}-15`, [[w.sales, 0, 1500], [w.rent, 50, 0]]);
  await fx.journal(w, `${m[1]}-25`, [[w.salaries, 250, 0]], { source: 'auto_payroll' });
  await fx.journal(w, `${m[2]}-10`, [[w.sales, 0, 999]]);
  await fx.close(w, [m[0]!, m[1]!]);
}, 180000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const create = (versionId: string, body: Record<string, unknown>) => fx.call.reforecast(w.u, versionId, 'POST', body);
const versions = async () => Number((await pool.query('SELECT count(*)::int AS n FROM budget_versions WHERE company_id = $1', [w.u.homeCompanyId])).rows[0].n);

describe('budget reforecast from actuals', () => {
  let rf: Created;

  it('creates a draft reforecast based on the source: closed months are actuals at each grain, open months keep the source', async () => {
    const r = await create(source, { name: 'Reforecast Q2' });
    expect(r.status, dump(r)).toBe(201);
    rf = dataOf<Created>(r);
    expect(rf.version).toMatchObject({ kind: 'reforecast', status: 'draft', basedOnVersionId: source });
    expect(rf.closedMonths).toEqual([m[0], m[1]]);
    const v = rf.version.id;
    const open = (value: string) => Array(10).fill(value);
    expect([...(await fx.cellsOf(v, w.sales)).values()]).toEqual(['1300.00:actual', '1500.00:actual', ...open('1000.00:manual')]);
    expect([...(await fx.cellsOf(v, w.cogs)).values()]).toEqual(['400.00:actual', '0.00:actual', ...open('380.00:driver')]);
    expect([...(await fx.cellsOf(v, w.salaries, w.cc1)).values()]).toEqual(['300.00:actual', '0.00:actual', ...open('500.00:manual')]);
    expect([...(await fx.cellsOf(v, w.salaries, w.cc1b)).entries()]).toEqual([[m[0], '150.00:actual'], [m[1], '0.00:actual']]);
    // Untagged labour never lands on a company row beside the CC1 rows.
    expect((await fx.cellsOf(v, w.salaries, null)).size).toBe(0);
    // Growth feeds off April's actual: 50 → 55 → 60.50, rounded once to R61.
    const rent = await fx.cellsOf(v, w.rent);
    expect([rent.get(m[0]!), rent.get(m[1]!), rent.get(m[2]!), rent.get(m[3]!)]).toEqual(['40.00:actual', '50.00:actual', '55.00:driver', '61.00:driver']);
    // Every row holds an 'actual' cell in every closed month (PR-3 reads such a month as closed).
    const missing = (await pool.query(
      `SELECT DISTINCT gl_account_id, cc1_id, cc2_id, bu_id, mm FROM budget_month_amounts r CROSS JOIN unnest($2::DATE[]) AS mm
        WHERE r.version_id = $1 AND NOT EXISTS (SELECT 1 FROM budget_month_amounts a WHERE a.version_id = r.version_id
          AND a.gl_account_id = r.gl_account_id AND a.cc1_id IS NOT DISTINCT FROM r.cc1_id AND a.cc2_id IS NOT DISTINCT FROM r.cc2_id
          AND a.bu_id IS NOT DISTINCT FROM r.bu_id AND a.month = mm AND a.amount_source = 'actual')`,
      [v, [`${m[0]}-01`, `${m[1]}-01`]])).rows;
    expect(missing).toEqual([]);
    expect(rf.cells).toBe(Number((await pool.query('SELECT count(*)::int AS n FROM budget_month_amounts WHERE version_id = $1', [v])).rows[0].n));
  });

  it("reports untagged actuals on an account budgeted by CC1 as unplaced, payroll's labour lines included, never dropped", () => {
    expect(rf.unplaced).toEqual([
      { accountId: w.salaries, accountCode: 'GS-6500', accountName: 'Salaries', level: 'cc1', month: m[0], amount: 200 },
      { accountId: w.salaries, accountCode: 'GS-6500', accountName: 'Salaries', level: 'cc1', month: m[1], amount: 250 },
    ]);
  });

  it("the version's status recomputes the same unplaced actuals the create reported", async () => {
    const r = await fx.call.reforecast(w.u, rf.version.id, 'GET');
    expect(r.status, dump(r)).toBe(200);
    expect(dataOf<{ unplaced: unknown[]; rolling: boolean }>(r)).toMatchObject({ rolling: false, unplaced: rf.unplaced });
  });

  it("closed-month cells equal P3's actuals reader at each grain, and BvA's actual is the cells plus the unplaced amount", async () => {
    const v = rf.version.id;
    const c = w.u.homeCompanyId;
    const start = `${m[0]}-01`, end = `${m[1]}-30`;
    const [company, cc1, report] = await asRequest(pool, c, w.u.userId, async () => [
      await readTrackingActuals(c, start, end, {}, null),
      await readTrackingActuals(c, start, end, {}, 'cc1'),
      await buildBudgetTrackingReport(c, { period: 'fy', fiscalYear: w.label, versionId: v }),
    ] as const, { appUser: true });
    const cents = (s: string) => Math.round(Number(s.split(':')[0]) * 100);
    const cell = async (acct: string, month: string, member: string | null) => (await fx.cellsOf(v, acct, member)).get(month);
    for (const a of company.filter((x) => x.accountId !== w.salaries)) {
      expect(cents((await cell(a.accountId, a.month, null))!), `${a.accountCode} ${a.month}`).toBe(Math.round(a.amount * 100));
    }
    for (const a of cc1.filter((x) => x.accountId === w.salaries && x.memberId !== null)) {
      expect(cents((await cell(a.accountId, a.month, a.memberId))!), `${a.accountCode} ${a.memberId} ${a.month}`).toBe(Math.round(a.amount * 100));
    }
    for (const line of report.lines) {
      for (const mm of line.monthly.filter((x) => x.month === m[0] || x.month === m[1])) {
        const rows = (await pool.query(
          `SELECT COALESCE(SUM(amount), 0)::text AS s FROM budget_month_amounts WHERE version_id = $1 AND gl_account_id = $2 AND month = $3`,
          [v, line.accountId, `${mm.month}-01`])).rows;
        const unplaced = rf.unplaced.filter((u) => u.accountId === line.accountId && u.month === mm.month).reduce((s, u) => s + u.amount, 0);
        expect(Math.round(Number(rows[0].s) * 100) + Math.round(unplaced * 100), `${line.accountCode} ${mm.month}`).toBe(Math.round(mm.actual * 100));
      }
    }
    expect(report.lines.length).toBeGreaterThanOrEqual(4);
  });

  it('refreshes headcount (nothing frozen): per-head cells follow the hires as they are now, not the source', async () => {
    const v = rf.version.id;
    expect(rf.headcountAsOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await fx.cellsOf(source, w.child1)).get(m[5]!)).toBe('100.00:driver');
    expect([...(await fx.cellsOf(v, w.child1)).values()]).toEqual([
      '0.00:actual', '0.00:actual', '0.00:driver', '100.00:driver', '100.00:driver', ...Array(7).fill('200.00:driver'),
    ]);
  });

  it('copies the drivers and planned hires (recomputed over the result) and audits the reforecast', async () => {
    const v = rf.version.id;
    const drivers = async (id: string) => (await pool.query(
      `SELECT gl_account_id, cc1_id, kind, from_month::text, to_month::text, amount::text, pct::text, ref_gl_account_id, base_month::text, rounding_unit
         FROM budget_driver_lines WHERE version_id = $1 ORDER BY gl_account_id`, [id])).rows;
    const hires = async (id: string) => (await pool.query(
      'SELECT label, cost_centre_id, start_month::text, end_month::text, fte::text FROM budget_planned_hires WHERE version_id = $1', [id])).rows;
    expect(await drivers(v)).toEqual(await drivers(source));
    expect((await drivers(v)).length).toBe(3);
    expect(await hires(v)).toEqual(await hires(source));
    expect((await hires(v)).length).toBe(2);
    // createVersion's 'create' row and this one share the transaction's now(): find it by content, not order.
    const rows = (await fx.audits(v)).filter((a) => a.changes.metadata?.reforecastFrom);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changes.metadata).toMatchObject({
      reforecastFrom: source, closedMonths: `${m[0]},${m[1]}`, cells: String(rf.cells),
      unplaced: `GS-6500 ${m[0]} 200.00; GS-6500 ${m[1]} 250.00`, unplacedTotal: '450', rolling: 'false',
      headcountAsOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
  });

  it('reads a locked source (it is only read); the reforecast is a draft with the same cells', async () => {
    const locked = await fx.version(w);
    for (const month of m) await fx.amount(w, locked, w.sales, month, 1000);
    await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [locked, w.u.userId]);
    await pool.query(`UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = clock_timestamp() WHERE id = $1`, [locked, w.u.userId]);
    const r = await create(locked, { name: 'From locked' });
    expect(r.status, dump(r)).toBe(201);
    const made = dataOf<Created>(r);
    expect(made.version.status).toBe('draft');
    expect([...(await fx.cellsOf(made.version.id, w.sales)).values()].slice(0, 3)).toEqual(['1300.00:actual', '1500.00:actual', '1000.00:manual']);
    expect((await pool.query('SELECT status FROM budget_versions WHERE id = $1', [locked])).rows[0].status).toBe('locked');
  });

  it("the reforecast's closed months are read-only in the grid: an actual cannot be typed over, nor a new cell typed in", async () => {
    const v = rf.version.id;
    const before = await fx.cells(v);
    const cell = (glAccountId: string, month: string, amount: number) => ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount });
    for (const c of [cell(w.sales, m[0]!, 1), cell(w.child2, m[1]!, 5)]) {
      const r = await fx.call.save(w.u, v, [c]);
      expect([r.status, details(r).code], dump(r)).toEqual([400, 'BUDGET_VERSION_INPUT']);
      expect(String(r.body.error?.message)).toMatch(/is a closed month of this budget/);
    }
    // An open month still takes a typed cell.
    expect((await fx.call.save(w.u, v, [cell(w.child2, m[2]!, 5)])).status).toBe(200);
    expect((await fx.cells(v)).length).toBe(before.length + 1);
  });

  it('a stored driver loop sits out with a DRIVER_SKIPPED warning; its rows plan as driverless, values kept', async () => {
    const looped = await fx.version(w);
    for (const month of m) await fx.amount(w, looped, w.sales, month, 1000);
    const cogs = await fx.call.drivers(w.u, 'PUT', {
      versionId: looped, glAccountId: w.cogs, kind: 'pct_of_line', pct: 38, fromMonth: m[0], toMonth: m[11], ref: { glAccountId: w.sales },
    });
    expect(cogs.status, dump(cogs)).toBe(200);
    // Written past the save-time cycle check, as a stored loop would be (a skipped driver come back).
    await pool.query(
      `INSERT INTO budget_driver_lines (company_id, version_id, gl_account_id, kind, from_month, to_month, pct, ref_gl_account_id, created_by)
       VALUES ($1, $2, $3, 'pct_of_line', $4, $5, 10, $6, $7)`,
      [w.u.homeCompanyId, looped, w.sales, `${m[0]}-01`, `${m[11]}-01`, w.cogs, w.u.userId]);
    const r = await create(looped, { name: 'From a loop' });
    expect(r.status, dump(r)).toBe(201);
    const made = dataOf<Created>(r);
    expect(made.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DRIVER_SKIPPED', message: expect.stringMatching(/GS-\d+ .* form a loop; change one of them/) }),
    ]));
    expect([...(await fx.cellsOf(made.version.id, w.sales)).values()].slice(0, 3)).toEqual(['1300.00:actual', '1500.00:actual', '1000.00:manual']);
    expect([...(await fx.cellsOf(made.version.id, w.cogs)).values()].slice(0, 3)).toEqual(['400.00:actual', '0.00:actual', '380.00:manual']);
  });

  it("another company's source version is a 404 and creates nothing", async () => {
    const other = await fx.world();
    const theirs = await fx.version(other);
    const before = await versions();
    const r = await create(theirs, { name: 'Not mine' });
    expect([r.status, details(r).code], dump(r)).toEqual([404, 'BUDGET_VERSION_NOT_FOUND']);
    expect(await versions()).toBe(before);
  });

  it('a rolling reforecast records its row; a second rolling one in the year is a 409 and leaves no version behind', async () => {
    const r = await create(source, { name: 'Rolling', rolling: true });
    expect(r.status, dump(r)).toBe(201);
    const made = dataOf<Created>(r);
    expect(made.rolling).toBe(true);
    expect(await fx.rollingRow(made.version.id)).toMatchObject({ through: null, last_error: null });
    const before = await versions();
    const again = await create(source, { name: 'Rolling 2', rolling: true });
    expect([again.status, details(again).code], dump(again)).toEqual([409, 'BUDGET_VERSION_STATE']);
    expect(String(again.body.error?.message)).toMatch(/already has a rolling forecast \('Rolling'\)/);
    expect(await versions()).toBe(before);
  });

  it('refuses a bad body (400 / 422) and a taken name (409), creating nothing', async () => {
    const before = await versions();
    expect((await create(source, { name: '' })).status).toBe(400);
    expect((await create(source, { name: 'x', extra: 1 })).status).toBe(422);
    const taken = await create(source, { name: 'Reforecast Q2' });
    expect([taken.status, details(taken).code], dump(taken)).toEqual([409, 'BUDGET_VERSION_STATE']);
    expect(await versions()).toBe(before);
  });
});
