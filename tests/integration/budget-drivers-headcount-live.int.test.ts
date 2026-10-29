/**
 * Budgets P4 headcount on demand (spec §5: payroll edits never push a recompute). A per_head row
 * reads headcount only on "Refresh headcount" (audit `headcountAsOf`), a planned-hire write, or its
 * own driver write; a grid save, or a driver write on another row, keeps it as it stands even after
 * payroll changed. Real members through withAuth; payroll rows are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetDriverRouteFixture, dataOf, type DriverWorld, type RouteOut } from './helpers/budgetDriverRouteFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fx = budgetDriverRouteFixture(pool);
let w: DriverWorld;

beforeAll(async () => { w = await fx.world(); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [w.u.homeCompanyId]);
    await fx.cleanup();
  } finally { await pool.end(); }
}, 120000);

const dump = (r: RouteOut) => `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
const rentIn = async (v: string, i: number) => (await fx.row(v, w.rent)).get(w.months[i]!)!.amount;

/** A version with Rent = R1 000 a head (company scope) and no heads yet; then one payroll hire nobody refreshed. */
async function perHeadThenPayrollHire() {
  await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [w.u.homeCompanyId]);
  const v = await fx.version(w);
  const put = await fx.call.drivers(w.u, 'PUT', {
    versionId: v, glAccountId: w.rent, kind: 'per_head', amount: 1000, fromMonth: w.months[0], toMonth: w.months[11],
  });
  expect(put.status, dump(put)).toBe(200);
  expect(await rentIn(v, 5)).toBe('0.00');
  await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status)
     VALUES ($1, $2, 'A', 'B', $3, 'active')`, [w.u.homeCompanyId, `HL-${crypto.randomUUID().slice(0, 8)}`, `${w.months[0]}-01`]);
  return v;
}

describe('per_head rows read headcount on demand only', () => {
  it('an unrelated grid save and another row\'s driver write leave it; Refresh headcount moves it and audits headcountAsOf (REPRO 2)', async () => {
    const v = await perHeadThenPayrollHire();
    const save = await fx.call.save(w.u, v, [{ glAccountId: w.sales, cc1Id: null, cc2Id: null, buId: null, month: w.months[0], amount: 5 }]);
    expect(save.status, dump(save)).toBe(200);
    expect(await rentIn(v, 5)).toBe('0.00');
    expect((await fx.audits(v)).at(-1)!.changes.metadata).not.toHaveProperty('headcountAsOf');
    const other = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.cogs, kind: 'fixed', amount: 10, fromMonth: w.months[0], toMonth: w.months[0],
    });
    expect(other.status, dump(other)).toBe(200);
    expect(await rentIn(v, 5)).toBe('0.00');

    const refresh = await fx.call.headcount(w.u, 'POST', { versionId: v });
    expect(refresh.status, dump(refresh)).toBe(200);
    const { headcountAsOf, recomputed } = dataOf<{ headcountAsOf: string; recomputed: number }>(refresh);
    expect(recomputed).toBe(12);
    expect(await rentIn(v, 5)).toBe('1000.00');
    expect((await fx.audits(v)).at(-1)!.changes.metadata).toMatchObject({ driverAction: 'headcount_refresh', headcountAsOf });
  });

  it("the row's own driver write and a planned-hire write read headcount", async () => {
    const v = await perHeadThenPayrollHire();
    const own = await fx.call.drivers(w.u, 'PUT', {
      versionId: v, glAccountId: w.rent, kind: 'per_head', amount: 2000, fromMonth: w.months[0], toMonth: w.months[11],
    });
    expect(own.status, dump(own)).toBe(200);
    expect(await rentIn(v, 5)).toBe('2000.00');
    await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status)
       VALUES ($1, $2, 'C', 'D', $3, 'active')`, [w.u.homeCompanyId, `HL-${crypto.randomUUID().slice(0, 8)}`, `${w.months[0]}-01`]);
    const hire = await fx.call.hires(w.u, 'POST', { versionId: v, label: 'Clerk', startMonth: w.months[11] });
    expect(hire.status, dump(hire)).toBe(200);
    // Payroll is read again: two employees from month 0 (R4 000), plus the hire in month 11 (R6 000).
    expect(await rentIn(v, 5)).toBe('4000.00');
    expect(await rentIn(v, 11)).toBe('6000.00');
  });
});
