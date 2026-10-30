/**
 * Budgets P4: driver loops stored behind the save-time check (a skipped driver's account comes back,
 * or an account is re-subtyped into a section a driver reads). The save check sees every stored
 * driver, skipped ones included, but refuses only a loop through the row being saved; a stored
 * loop is survivable everywhere: its drivers sit out each recompute, their rows keep their cells,
 * a labelled DRIVER_SKIPPED warning names it, and the grid's clear rules treat its rows as skipped
 * (an override cleared there is a plain delete, not a reset). Real members through withAuth.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, dataOf, details, type DriverWorld, type RouteOut } from './helpers/budgetDriverRouteFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
let w: DriverWorld;

beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const cell = (glAccountId: string, month: string, amount: number | null) =>
  ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount, ...(amount === null ? { clear: true } : {}) });
const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
type Warning = { code: string; rowKey: string; message: string };
/** The warnings a grid save (`driverWarnings`) or a driver write (`warnings`) answers. */
const loopWarnings = (r: RouteOut): Warning[] => {
  const d = dataOf<{ driverWarnings?: Warning[]; warnings?: Warning[] }>(r);
  return d.driverWarnings ?? d.warnings ?? [];
};

describe('a loop through a driver skipped today (N1)', () => {
  /** COGS = 38% of Sales (fx.cogsOfSales) and Sales = 10% of Rent. */
  async function chain() {
    const { v } = await fx.cogsOfSales(w);
    const put = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.sales, kind: 'pct_of_line', pct: 10, fromMonth: w.months[0], toMonth: w.months[11], ref: { glAccountId: w.rent },
    });
    expect(put.status, dump(put)).toBe(200);
    return v;
  }

  it('a save that closes a loop through a driver skipped today is 400 DRIVER_CYCLE (the check sees every stored driver)', async () => {
    const v = await chain();
    await pool.query(`UPDATE gl_accounts SET account_type = 'asset', account_subtype = NULL WHERE id = $1`, [w.sales]);
    try {
      const before = await fx.state(v);
      const r = await fx.call.drivers(w.u, 'PUT', {
        versionId: v, glAccountId: w.rent, kind: 'pct_of_line', pct: 10, fromMonth: w.months[0], toMonth: w.months[11], ref: { glAccountId: w.cogs },
      });
      expect([r.status, details(r).code], dump(r)).toEqual([400, 'DRIVER_CYCLE']);
      const path = details(r).path as string[];
      expect([path[0], new Set(path.map((k) => k.split('|')[0]))]).toEqual([path[path.length - 1], new Set([w.rent, w.cogs, w.sales])]);
      expect(await fx.state(v)).toEqual(before);
    } finally {
      await pool.query(`UPDATE gl_accounts SET account_type = 'revenue', account_subtype = NULL WHERE id = $1`, [w.sales]);
    }
  });

  it('a loop already stored is survivable: its rows are frozen and named in a DRIVER_SKIPPED warning; other saves succeed', async () => {
    const v = await chain();
    // Close Rent -> COGS -> Sales -> Rent behind the save-time check (as a skipped driver's account coming back would).
    await pool.query(
      `INSERT INTO budget_driver_lines (company_id, version_id, gl_account_id, kind, from_month, to_month, pct, ref_gl_account_id, created_by)
       VALUES ($1, $2, $3, 'pct_of_line', $4, $5, 10, $6, $7)`,
      [w.u.homeCompanyId, v, w.rent, `${w.months[0]}-01`, `${w.months[11]}-01`, w.cogs, w.u.userId]);
    const pinned = { cogs: await fx.row(v, w.cogs), sales: await fx.row(v, w.sales) };
    const r = await fx.call.save(w.u, v, [cell(w.header, w.months[1]!, null), cell(w.child1, w.months[1]!, 9)]);
    expect(r.status, dump(r)).toBe(200);
    const loops = loopWarnings(r).filter((x) => x.code === 'DRIVER_SKIPPED');
    expect(loops).toHaveLength(1);
    expect(loops[0]!.message).toMatch(/^drivers on .* form a loop; change one of them$/);
    for (const name of ['GS-5100 Cost of sales', 'GS-4000 Sales', 'BR-5000 Rent']) expect(loops[0]!.message).toContain(name);
    expect({ cogs: await fx.row(v, w.cogs), sales: await fx.row(v, w.sales) }).toEqual(pinned);
  });
});

describe('a loop stored through a section (breaker round 3)', () => {
  /** Rent = 50% of the cost_of_sales section; X (opex) = 10% of Rent; then X is re-subtyped into cost_of_sales. */
  async function storedLoop() {
    const v = await fx.version(w);
    for (const m of w.months.slice(0, 3)) await fx.amount(w, v, w.cogs, m, 1000);
    const x = String((await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
       VALUES ($1, $2, 'Loop X', 'expense', 'operating_expense', 'debit', 3, true) RETURNING id`,
      [w.u.homeCompanyId, `GS-66${v.slice(0, 4)}`])).rows[0].id);
    const a = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, kind: 'pct_of_section', pct: 50, section: 'cost_of_sales', scope: 'company',
      fromMonth: w.months[0], toMonth: w.months[11],
    });
    const b = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: x, kind: 'pct_of_line', pct: 10, ref: { glAccountId: w.rent }, fromMonth: w.months[0], toMonth: w.months[11],
    });
    expect([a.status, b.status], `${dump(a)} ${dump(b)}`).toEqual([200, 200]);
    await pool.query(`UPDATE gl_accounts SET account_subtype = 'cost_of_sales' WHERE id = $1`, [x]);
    return { v, x };
  }

  it('R3-A: unrelated grid saves work; the loop is warned and its rows keep their cells', async () => {
    const { v } = await storedLoop();
    const before = await fx.row(v, w.rent);
    const r = await fx.call.save(w.u, v, [cell(w.sales, w.months[0]!, 5)]);
    expect(r.status, dump(r)).toBe(200);
    expect(loopWarnings(r).some((x) => x.code === 'DRIVER_SKIPPED' && /form a loop/.test(x.message)), dump(r)).toBe(true);
    expect(await fx.row(v, w.rent)).toEqual(before);
  });

  it('R3-B: a driver outside the stored loop saves (200, the loop still warned); one that joins it is 400 DRIVER_CYCLE', async () => {
    const { v, x } = await storedLoop();
    const free = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.sales, kind: 'fixed', amount: 100, fromMonth: w.months[0], toMonth: w.months[11],
    });
    expect(free.status, dump(free)).toBe(200);
    expect(loopWarnings(free).some((y) => y.code === 'DRIVER_SKIPPED' && /form a loop/.test(y.message)), dump(free)).toBe(true);
    const before = await fx.state(v);
    // COGS sits in cost_of_sales (Rent reads the section): COGS = 10% of X closes COGS -> Rent -> X -> COGS.
    const joins = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.cogs, kind: 'pct_of_line', pct: 10, ref: { glAccountId: x }, fromMonth: w.months[0], toMonth: w.months[11],
    });
    expect([joins.status, details(joins).code], dump(joins)).toEqual([400, 'DRIVER_CYCLE']);
    expect((details(joins).path as string[])).toContain(`${w.cogs}|||`);
    expect(await fx.state(v)).toEqual(before);
  });

  it('R3-C: on a looped (frozen) row, an override clear and a driver-cell clear are both plain deletes: reset 0', async () => {
    const { v, x } = await storedLoop();
    const typed = await fx.call.save(w.u, v, [cell(x, w.months[0]!, 999)]);
    expect(typed.status, dump(typed)).toBe(200);
    const row = await fx.row(v, x);
    expect([row.get(w.months[0]!)!.source, row.get(w.months[1]!)!.source]).toEqual(['override', 'driver']);
    const override = await fx.call.save(w.u, v, [cell(x, w.months[0]!, null)]);
    expect(override.status, dump(override)).toBe(200);
    expect(dataOf(override)).toMatchObject({ deleted: 1, reset: 0 });
    // A 'driver' cell of a looped row is not "computed by the driver" (it computes nothing): no 400.
    const computed = await fx.call.save(w.u, v, [cell(x, w.months[1]!, null)]);
    expect(computed.status, dump(computed)).toBe(200);
    expect(dataOf(computed)).toMatchObject({ deleted: 1, reset: 0 });
    const after = await fx.row(v, x);
    expect([after.get(w.months[0]!), after.get(w.months[1]!)]).toEqual([undefined, undefined]);
  });
});
