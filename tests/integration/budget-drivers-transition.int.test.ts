/**
 * Budgets P4 in a 14-month transition year (budgetGridFixture's transition company: FY2027 =
 * January 2026 - February 2027): a driver over the whole year computes all FOURTEEN months, a
 * growth driver compounds across them, and a pct_of_line dependant follows a grid edit in month 14.
 * The months come from the registry, never a hard-coded 12. Real members through withAuth.
 *
 * Worked by hand: Sales R1 000 fixed; growth 10% m/m from base January 2026 = R1 000 → February
 * R1 100 … January 2027 (12 steps) = R3 138, February 2027 (13) = round(1 000 × 1.1^13) = R3 452;
 * COGS = 50% of Sales: R1 569 and R1 726, then R2 000 after Sales month 14 is typed as R4 000.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import driversRoute from '../../pages/api/accounting/budget-drivers/index';
import saveRoute from '../../pages/api/accounting/budget-grid/save';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';
import { TOKEN_SQL } from './helpers/budgetGridSaveFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const MONTHS = monthsFrom('2026-01', 14);
let T: GridCo;

beforeAll(async () => { T = await fx.company({ transition: true }); }, 120000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120000);

const token = async (v: string) => String((await pool.query(`SELECT ${TOKEN_SQL} AS t FROM budget_versions WHERE id = $1`, [v])).rows[0].t);
const put = async (v: string, body: Record<string, unknown>) =>
  fx.call(driversRoute, '/api/accounting/budget-drivers', T.owner, 'PUT', {}, { versionId: v, expectedUpdatedAt: await token(v), ...body });
const row = async (v: string, acct: string) => (await pool.query(
  `SELECT to_char(month, 'YYYY-MM') AS m, amount::text AS a, amount_source AS s FROM budget_month_amounts
    WHERE version_id = $1 AND gl_account_id = $2 ORDER BY month`, [v, acct])).rows as Array<{ m: string; a: string; s: string }>;
const dump = (r: { status: number; body: unknown }) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;

describe('drivers in a 14-month transition year', () => {
  it('a fixed driver over the whole year writes all fourteen months', async () => {
    const v = await fx.version(T, { fy: 2027 });
    const r = await put(v, { glAccountId: T.acct.sales, kind: 'fixed', amount: 1000, fromMonth: MONTHS[0], toMonth: MONTHS[13] });
    expect(r.status, dump(r)).toBe(200);
    expect((r.body.data as { recomputed: number }).recomputed).toBe(14);
    expect(await row(v, T.acct.sales)).toEqual(MONTHS.map((m) => ({ m, a: '1000.00', s: 'driver' })));
  });

  it('growth compounds across the fourteen months, and a dependant follows an edit in month 14', async () => {
    const v = await fx.version(T, { fy: 2027 });
    await fx.amount(T, v, T.acct.sales, MONTHS[0]!, 1000);
    const g = await put(v, { glAccountId: T.acct.sales, kind: 'growth', pct: 10, baseMonth: MONTHS[0], fromMonth: MONTHS[1], toMonth: MONTHS[13] });
    expect(g.status, dump(g)).toBe(200);
    const sales = await row(v, T.acct.sales);
    expect(sales.map((x) => x.m)).toEqual(MONTHS);
    expect([sales[1]!.a, sales[2]!.a, sales[13]!.a]).toEqual(['1100.00', '1210.00', '3452.00']);
    const c = await put(v, { glAccountId: T.acct.cos, kind: 'pct_of_line', pct: 50, fromMonth: MONTHS[0], toMonth: MONTHS[13], ref: { glAccountId: T.acct.sales } });
    expect(c.status, dump(c)).toBe(200);
    expect((await row(v, T.acct.cos))[13]!.a).toBe('1726.00');
    // Typing over Sales in month 14 (an override) moves COGS month 14 only.
    const save = await fx.call(saveRoute, '/api/accounting/budget-grid/save', T.owner, 'POST', {}, {
      versionId: v, expectedUpdatedAt: await token(v),
      cells: [{ glAccountId: T.acct.sales, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[13], amount: 4000 }],
    });
    expect(save.status, dump(save)).toBe(200);
    expect(save.body.data).toMatchObject({ saved: 1, recomputed: 1 });
    const cos = await row(v, T.acct.cos);
    expect([cos[12]!.a, cos[13]!.a]).toEqual(['1569.00', '2000.00']);
  });
});
