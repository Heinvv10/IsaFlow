/**
 * Wave 6 OC (review #1549 D1 follow-up): the owner cash position's payroll summary is the month's still-due figure.
 * May holds a bonus paid on 15 May (approved on its pay date, so paid) and the regular run due 31 May. On 20 May the
 * summary must be the regular run's cumulative due figure, never the paid bonus judged on its own.
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
    const got = await twoRunsInMonth(pool, A, async (c) => {
      ids.regular = await seedRun(c, A, REGULAR);
      ids.bonus = await seedRun(c, A, BONUS);
    }, () => getOwnerCashPosition(A.company, 22_000, new Date('2026-05-20T10:00:00Z')));
    expect(got.payroll).toMatchObject({ runId: ids.regular, canPay: true, runsCounted: 1 });
    // The regular run alone, as the cash position shapes it, is what the month still needs.
    const alone = await twoRunsInMonth(pool, A, async (c) => { await seedRun(c, A, REGULAR); },
      () => getOwnerCashPosition(A.company, 22_000, new Date('2026-05-20T10:00:00Z')));
    expect(got.payroll?.totalRequired).toBe(alone.payroll?.totalRequired);
    expect(got.payroll?.totalRequired).toBeGreaterThan(5_000);
  });
});
