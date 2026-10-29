/**
 * Budgets P4: the grid save's driver hook (P2 `saveCells` through its route, real members through
 * withAuth). Closed months (any month holding an 'actual' cell) are read-only (no cell typed or
 * cleared there, an override included) and take no driver figure; a 'driver' cell cannot be cleared, an 'override' clear
 * is a reset to driver; typing the driver's own value changes nothing; the recompute's warnings
 * reach the answer and the audit row; a driver that can no longer compute (its account retyped
 * out of the income statement) is skipped with a labelled warning instead of blocking every save;
 * a result beyond the budget range is 400 DRIVER_RANGE. Refusals write nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, dataOf, details, type DriverWorld, type RouteOut } from './helpers/budgetDriverRouteFixture';
import { errCode } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
let w: DriverWorld;

beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const cell = (glAccountId: string, month: string, amount: number | null, cc1Id: string | null = null) =>
  ({ glAccountId, cc1Id, cc2Id: null, buId: null, month, amount, ...(amount === null ? { clear: true } : {}) });
const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
type Warning = { code: string; rowKey: string; message: string };
const lastAudit = async (v: string) => (await fx.audits(v)).at(-1)!.changes.metadata as Record<string, string>;

async function refused(v: string, cells: unknown[], code = 'BUDGET_VERSION_INPUT'): Promise<RouteOut> {
  const before = await fx.state(v);
  const r = await fx.call.save(w.u, v, cells);
  expect([r.status, errCode(r)], dump(r)).toEqual([400, code]);
  expect(await fx.state(v)).toEqual(before);
  return r;
}

describe('grid save hook: closed months', () => {
  /** A reforecast-shaped version: month 0 closed (Sales holds its actual 700). */
  async function reforecast() {
    const v = await fx.version(w);
    await fx.amount(w, v, w.sales, w.months[0]!, 700);
    await pool.query(`UPDATE budget_month_amounts SET amount_source = 'actual' WHERE version_id = $1`, [v]);
    return v;
  }

  it('typing over an actual, typing a NEW cell in a closed month, and clearing an actual are each 400; nothing changes', async () => {
    const v = await reforecast();
    const [m0, m1] = w.months;
    const over = await refused(v, [cell(w.rent, m1!, 5), cell(w.sales, m0!, 9)]);
    expect(String(over.body.error?.message)).toMatch(/closed month .*GS-4000 Sales/);
    const fresh = await refused(v, [cell(w.rent, m0!, 5)]);
    expect(String(fresh.body.error?.message)).toBe(`Month ${m0} is a closed month of this budget (it holds the ledger's actuals): account BR-5000 Rent cannot be typed in or cleared there`);
    const clear = await refused(v, [cell(w.sales, m0!, null)]);
    expect(String(clear.body.error?.message)).toMatch(/closed month .*GS-4000 Sales cannot be typed in or cleared there/);
  });

  it('clearing an override (or any cell) in a closed month is 400: it would never be refilled', async () => {
    const v = await reforecast();
    const put = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, kind: 'fixed', amount: 1500, fromMonth: w.months[0], toMonth: w.months[11],
    });
    expect(put.status, dump(put)).toBe(200);
    // An override and a manual cell left in the closed month (from before it closed).
    await fx.amount(w, v, w.rent, w.months[0]!, 99);
    await fx.amount(w, v, w.cogs, w.months[0]!, 11);
    await pool.query(`UPDATE budget_month_amounts SET amount_source = 'override' WHERE version_id = $1 AND gl_account_id = $2 AND month = $3`,
      [v, w.rent, `${w.months[0]}-01`]);
    for (const acct of [w.rent, w.cogs]) {
      const r = await refused(v, [cell(acct, w.months[0]!, null)]);
      expect(String(r.body.error?.message)).toMatch(/is a closed month of this budget/);
    }
  });

  it('a driver added to a reforecast never writes a closed month (REPRO 3)', async () => {
    const v = await reforecast();
    const put = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, kind: 'fixed', amount: 1500, fromMonth: w.months[0], toMonth: w.months[11],
    });
    expect(put.status, dump(put)).toBe(200);
    const rent = await fx.row(v, w.rent);
    expect(rent.get(w.months[0]!)).toBeUndefined();
    expect([...rent.keys()]).toEqual(w.months.slice(1));
  });
});

describe('grid save hook: driver and override cells', () => {
  it('clearing a driver cell inside its range is 400 naming the driver; clearing an override resets it (reset: 1)', async () => {
    const { v } = await fx.cogsOfSales(w);
    const [m0, m1] = w.months;
    const r = await refused(v, [cell(w.cogs, m1!, null)]);
    expect(String(r.body.error?.message)).toBe(`Account GS-5100 Cost of sales month ${m1} is computed by the driver on GS-5100 Cost of sales: change or delete the driver`);
    expect((await fx.call.save(w.u, v, [cell(w.cogs, m0!, 500), cell(w.cogs, m1!, 77)])).status).toBe(200);
    const reset = await fx.call.save(w.u, v, [cell(w.cogs, m0!, null)]);
    expect(reset.status, dump(reset)).toBe(200);
    expect(dataOf(reset)).toMatchObject({ deleted: 1, reset: 1, recomputed: 1 });
    const cogs = await fx.row(v, w.cogs);
    expect(cogs.get(m0!)).toMatchObject({ amount: '380.00', source: 'driver' });
    expect(cogs.get(m1!)).toMatchObject({ amount: '77.00', source: 'override' });
    expect(await lastAudit(v)).toMatchObject({ reset: '1', deletes: '1', recomputed: '1' });
  });

  it("typing the value the driver already holds stays 'driver' and moves no token (REPRO 4); a new value overrides", async () => {
    const { v } = await fx.cogsOfSales(w);
    const before = await fx.token(v);
    const same = await fx.call.save(w.u, v, [cell(w.cogs, w.months[0]!, 380)]);
    expect(same.status, dump(same)).toBe(200);
    expect(dataOf(same)).toMatchObject({ saved: 0, deleted: 0 });
    expect((await fx.row(v, w.cogs)).get(w.months[0]!)!.source).toBe('driver');
    expect(await fx.token(v)).toBe(before);
    const mixed = await fx.call.save(w.u, v, [cell(w.cogs, w.months[0]!, 380), cell(w.cogs, w.months[1]!, 381)]);
    expect(dataOf(mixed)).toMatchObject({ saved: 1 });
    const cogs = await fx.row(v, w.cogs);
    expect([cogs.get(w.months[0]!)!.source, cogs.get(w.months[1]!)!.source]).toEqual(['driver', 'override']);
    expect(await lastAudit(v)).toMatchObject({ overrides: '1' });
  });
});

describe('grid save hook: warnings and drivers that cannot compute', () => {
  it('a save that empties a driver reference answers and audits the REF_MISSING warning, labelled (REPRO 1)', async () => {
    const { v } = await fx.cogsOfSales(w);
    // Sales moves from company level to CC1 in one batch (P2's grain change): COGS's company-level reference is now empty.
    const batch = w.months.slice(0, 3).flatMap((m) => [cell(w.sales, m, null), cell(w.sales, m, 1000, w.cc1)]);
    const r = await fx.call.save(w.u, v, batch);
    expect(r.status, dump(r)).toBe(200);
    expect((await fx.row(v, w.cogs)).get(w.months[0]!)!.amount).toBe('0.00');
    const warnings = dataOf<{ driverWarnings: Warning[] }>(r).driverWarnings;
    expect(warnings).toEqual([{ code: 'REF_MISSING', rowKey: `${w.cogs}|||`, message: expect.stringContaining('Referenced row GS-4000 Sales has no amount') }]);
    expect(warnings[0]!.message).not.toContain(w.sales);
    expect(JSON.parse((await lastAudit(v)).driverWarnings!)).toEqual(warnings);
  });

  it('a driven account retyped out of the income statement is skipped with a labelled warning; unrelated saves succeed (PROBE 7)', async () => {
    const { v } = await fx.cogsOfSales(w);
    const pinned = await fx.row(v, w.cogs);
    await pool.query(`UPDATE gl_accounts SET account_type = 'asset', account_subtype = NULL WHERE id = $1`, [w.cogs]);
    try {
      const r = await fx.call.save(w.u, v, [cell(w.sales, w.months[1]!, 2000)]);
      expect(r.status, dump(r)).toBe(200);
      expect(dataOf<{ driverWarnings: Warning[] }>(r).driverWarnings).toEqual([{
        code: 'DRIVER_SKIPPED', rowKey: `${w.cogs}|||`,
        message: 'driver on GS-5100 Cost of sales cannot compute: the account is no longer an income-statement account; change or delete the driver',
      }]);
      // Its cells are frozen as they stood (not re-sourced, not recomputed).
      expect(await fx.row(v, w.cogs)).toEqual(pinned);
      const save = await fx.call.drivers(w.u, 'PUT', {
        versionId: v, glAccountId: w.cogs, kind: 'fixed', amount: 5, fromMonth: w.months[0], toMonth: w.months[0],
      });
      expect([save.status, errCode(save)], dump(save)).toEqual([400, 'BUDGET_VERSION_INPUT']);
      expect(String(save.body.error?.message)).toMatch(/GS-5100 Cost of sales is not a revenue or expense account/);
    } finally {
      await pool.query(`UPDATE gl_accounts SET account_type = 'expense', account_subtype = 'cost_of_sales' WHERE id = $1`, [w.cogs]);
    }
  });

  it("a pct_of_line driver whose referenced account is retyped is skipped too, naming the account it reads", async () => {
    const { v } = await fx.cogsOfSales(w);
    await pool.query(`UPDATE gl_accounts SET account_type = 'asset', account_subtype = NULL WHERE id = $1`, [w.sales]);
    try {
      const r = await fx.call.save(w.u, v, [cell(w.rent, w.months[1]!, 9)]);
      expect(r.status, dump(r)).toBe(200);
      expect(dataOf<{ driverWarnings: Warning[] }>(r).driverWarnings.map((x) => x.message)).toEqual([
        'driver on GS-5100 Cost of sales cannot compute: the account it reads (GS-4000 Sales) is no longer an income-statement account; change or delete the driver',
      ]);
    } finally {
      await pool.query(`UPDATE gl_accounts SET account_type = 'revenue', account_subtype = NULL WHERE id = $1`, [w.sales]);
    }
  });

  it('a skipped driver (the account it reads retyped) can still be deleted, and its cells go manual (R2-D)', async () => {
    const { v, put } = await fx.cogsOfSales(w);
    await pool.query(`UPDATE gl_accounts SET account_type = 'asset', account_subtype = NULL WHERE id = $1`, [w.sales]);
    try {
      const id = dataOf<{ driver: { id: string } }>(put).driver.id;
      const r = await fx.call.drivers(w.u, 'DELETE', undefined, { versionId: v, id });
      expect(r.status, dump(r)).toBe(200);
      expect(new Set([...(await fx.row(v, w.cogs)).values()].map((x) => x.source))).toEqual(new Set(['manual']));
    } finally {
      await pool.query(`UPDATE gl_accounts SET account_type = 'revenue', account_subtype = NULL WHERE id = $1`, [w.sales]);
    }
  });

  it('a result beyond the budget range is 400 DRIVER_RANGE naming the account, and writes nothing', async () => {
    const v = await fx.version(w);
    const put = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.cogs, kind: 'pct_of_line', pct: 50000, fromMonth: w.months[0], toMonth: w.months[0],
      ref: { glAccountId: w.sales },
    });
    expect(put.status, dump(put)).toBe(200);
    const r = await refused(v, [cell(w.sales, w.months[0]!, 9_000_000_000_000)], 'DRIVER_RANGE');
    expect(String(r.body.error?.message)).toMatch(/GS-5100 Cost of sales/);
    expect(String(r.body.error?.message)).not.toContain(w.cogs);
    expect(details(r)).toEqual({ code: 'DRIVER_RANGE' });
  });
});
