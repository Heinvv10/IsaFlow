/**
 * Wave 6 OC (review #1549 D1 follow-up): the owner cash position's payroll summary is the month's still-due figure.
 * May holds a bonus paid on 15 May (approved on its pay date, so paid) and the regular run due 31 May. On 20 May the
 * summary must be the regular run's cumulative due figure, never the paid bonus judged on its own; the bonus counts only
 * its PAYE, UIF and SDL, owed until May's EMP201 is due (gate ruling 4 on 7630d9379f).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropTenants, seedRun, seedTenant, twoRunsInMonth, type RunSpec, type Tenant } from './w6-fqb1.helpers';
import { getOwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;
const REGULAR: RunSpec = { year: 2026, month: 5, runDate: '2026-05-25', noRunDate: true, gross: 20000, paye: 2000 };
const BONUS: RunSpec = { year: 2026, month: 5, runDate: '2026-05-15', offCycle: true, gross: 5000, paye: 700 };

beforeAll(async () => { A = await seedTenant(pool, 'w6 oc cash position A'); });
afterAll(async () => { try { await dropTenants(pool, [A]); } finally { await pool.end(); } });

describe('owner cash position: a paid bonus never stands in for the month\'s due runs', () => {
  it('20 May: the regular run due 31 May is the summary (one run counted, its own figure), not the bonus paid 15 May', async () => {
    const ids: Record<string, string> = {};
    let bonusStatutory = 0;
    const got = await twoRunsInMonth(pool, A, async (c) => {
      ids.regular = await seedRun(c, A, REGULAR);
      ids.bonus = await seedRun(c, A, BONUS);
      bonusStatutory = Number((await c.query(`SELECT (total_paye + total_uif + total_sdl - total_eti)::float8 AS s
        FROM payroll_run_headers WHERE id = $1`, [ids.bonus])).rows[0].s);
    }, () => getOwnerCashPosition(A.company, 30_000, new Date('2026-05-20T10:00:00Z')));
    // The paid bonus's net pay left on 15 May; its PAYE, UIF and SDL stay owed until May's EMP201 is due (7 June,
    // gate ruling 4 on 7630d9379f), so it counts that much beside the regular run, and the regular run is the summary.
    expect(bonusStatutory).toBeGreaterThan(0);
    expect(got.payroll).toMatchObject({ runId: ids.regular, canPay: true, runsCounted: 2 });
    const alone = await twoRunsInMonth(pool, A, async (c) => { await seedRun(c, A, REGULAR); },
      () => getOwnerCashPosition(A.company, 30_000, new Date('2026-05-20T10:00:00Z')));
    expect(got.payroll?.totalRequired).toBeCloseTo((alone.payroll?.totalRequired ?? 0) + bonusStatutory, 2);
    expect(got.payroll?.totalRequired).toBeGreaterThan(5_000);
  });

  it('a bonus marked paid still counts its PAYE, UIF and SDL until the EMP201 is due (review of fd9193cc2)', async () => {
    const PAID: RunSpec = { ...BONUS, status: 'paid', approvedAt: BONUS.runDate };
    let bonusStatutory = 0;
    const got = await twoRunsInMonth(pool, A, async (c) => {
      await seedRun(c, A, REGULAR);
      const id = await seedRun(c, A, PAID);
      bonusStatutory = Number((await c.query(`SELECT (total_paye + total_uif + total_sdl - total_eti)::float8 AS s
        FROM payroll_run_headers WHERE id = $1`, [id])).rows[0].s);
    }, () => getOwnerCashPosition(A.company, 30_000, new Date('2026-05-20T10:00:00Z')));
    const alone = await twoRunsInMonth(pool, A, async (c) => { await seedRun(c, A, REGULAR); },
      () => getOwnerCashPosition(A.company, 30_000, new Date('2026-05-20T10:00:00Z')));
    expect(bonusStatutory).toBeGreaterThan(0);
    expect(got.payroll?.runsCounted).toBe(2);
    expect(got.payroll?.totalRequired).toBeCloseTo((alone.payroll?.totalRequired ?? 0) + bonusStatutory, 2);
  });
});
