/**
 * Wave 6 FQc, review #1575 round 4 (G7): two overlapping weekly runs calculated at the same time, each in its own committed
 * transaction, as two requests would. Exactly one is costed; the other is refused (409 PAY_PERIOD_OVERLAP) with nothing
 * written. The runs fall in different months (27 June-3 July paid in July, 24-30 June paid in June), so the per-month
 * unique FQx drops is never touched and no DDL runs. Rows are committed, so the suite removes them itself.
 * The FQa run-kind guard is stubbed until FQd lifts its frequency clause; payrollFrequencyGuard runs for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { seedTenant, type Tenant } from './w6-fqb1.helpers';
import { cleanPayrollCompanies } from './w3-01-payroll.helpers';
import { seedWeekly, weeklyRun } from './w6-fqc.helpers';
import { als } from '@/lib/als';

vi.mock('@/modules/accounting/services/payroll/payrollRunKindGuard', async (orig) => ({
  ...await orig<typeof import('@/modules/accounting/services/payroll/payrollRunKindGuard')>(),
  assertRunKindSupported: vi.fn(async () => undefined),
}));

import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let A: Tenant;

beforeAll(async () => { A = await seedTenant(pool, 'W6 FQc race A'); });
afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id = $1)', [A.company]);
    await cleanPayrollCompanies(pool, [A.company]);
    await pool.query('DELETE FROM users WHERE id = $1', [A.user]);
  } finally { await pool.end(); }
});

describe('round 4 G7: two overlapping runs calculated concurrently', () => {
  it('exactly one is costed; the other is refused PAY_PERIOD_OVERLAP with no lines written', async () => {
    const setup = await pool.connect();
    let x = '';
    let y = '';
    try {
      await seedWeekly(setup, A);
      x = await weeklyRun(setup, A, ['2026-06-27', '2026-07-03'], 7);
      y = await weeklyRun(setup, A, ['2026-06-24', '2026-06-30'], 6);
    } finally { setup.release(); }
    const inTx = async (runId: string) => {
      const cl = await pool.connect();
      try {
        await cl.query('BEGIN');
        const r = await als.run({ client: cl, userId: A.user, companyId: A.company, claims: { sub: A.user } } as never,
          () => calculatePayrollRun(runId, A.company)).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
        await cl.query(r === 'ok' ? 'COMMIT' : 'ROLLBACK');
        return r;
      } finally { cl.release(); }
    };
    const results = await Promise.all([inTx(x), inTx(y)]);
    const costed = (await pool.query('SELECT count(DISTINCT run_id)::int AS n FROM payroll_run_lines WHERE run_id = ANY($1)', [[x, y]])).rows[0].n;
    expect(results.slice().sort()).toEqual(['PAY_PERIOD_OVERLAP', 'ok']);
    expect(costed).toBe(1);
  });
});
