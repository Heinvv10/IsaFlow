/**
 * Wave 6 FQc (review #1563, FQx's latent break): a payslip's year to date is bounded by RUN, in pay order
 * (payrollRunOrder), not by month. A month holding a regular run and a later off-cycle bonus: the regular payslip's
 * year to date is April + May regular only; the bonus's is all three.
 * FQx (999p) drops the per-month unique; FQc merges first, so the case drops it in its own transaction and rolls back
 * (w6-fqb1.helpers twoRunsInMonth).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedRun, seedTenant, twoRunsInMonth, type Tenant } from './w6-fqb1.helpers';
import { payslipYearToDate } from '@/modules/accounting/services/payroll/payslipYearToDate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
let B: Tenant;
beforeAll(async () => { A = await seedTenant(pool, 'W6 FQc payslip YTD A'); B = await seedTenant(pool, 'W6 FQc payslip YTD B'); });
afterAll(async () => { try { await dropTenants(pool, [A, B]); } finally { await pool.end(); } });

it('the 25 May regular payslip does not count the 30 May bonus; the bonus payslip counts all three runs', async () => {
  let reg = '';
  let bonus = '';
  const got = await twoRunsInMonth(pool, A, async (c) => {
    for (const t of [B, A]) {
      await seedRun(c, t, { year: 2026, month: 4, runDate: '2026-04-25', gross: 10000, paye: 1000 });
      const r = await seedRun(c, t, { year: 2026, month: 5, runDate: '2026-05-25', gross: 10000, paye: 1000 });
      const b = await seedRun(c, t, { year: 2026, month: 5, runDate: '2026-05-30', gross: 50000, paye: 20000, offCycle: true });
      if (t === A) { reg = r; bonus = b; }
    }
  }, async () => ({
    reg: (await payslipYearToDate(A.company, { id: reg, periodMonth: 5, periodYear: 2026 }, [A.employee])).get(A.employee),
    bonus: (await payslipYearToDate(A.company, { id: bonus, periodMonth: 5, periodYear: 2026 }, [A.employee])).get(A.employee),
  }));
  expect([got.reg?.grossPay, got.reg?.paye]).toEqual([20000, 2000]);
  expect([got.bonus?.grossPay, got.bonus?.paye]).toEqual([70000, 22000]);
});
