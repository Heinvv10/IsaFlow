/**
 * PAYE 4a follow-ups G4, breaker round 3 on PR B, ported: the approval gate
 * (paye_year_to_date_stale) under a reopened month and under CONCURRENT
 * approvals of January and February. Approvals of a company are serialised
 * (lockCompanyPayrollApprovals), so whichever lands second sees the other:
 * an earlier month approved after this run was calculated, or a later one,
 * both refuse until a recalculation. The year is never short without a
 * refusal or a warning.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import {
  approveRun, cleanSeveranceFixtures, runLine, type SeveranceFixture,
} from './p3-severance.helpers';
import { PERIODS, seedEmployee, setSalary } from './p4fu-cumulative.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function mk(f: SeveranceFixture, year: number, month: number): Promise<string> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  if (made.statusCode !== 201) throw new Error(`create: ${made.statusCode}`);
  return String(made.body.data!.id);
}
async function calcOnly(f: SeveranceFixture, id: string) {
  const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
  if (calc.statusCode !== 200) throw new Error(`calc ${calc.statusCode}`);
}
async function calcApprove(f: SeveranceFixture, id: string): Promise<number> {
  await calcOnly(f, id);
  const ok = await approveRun(f, id);
  if (ok.statusCode !== 200) throw new Error(`approve ${ok.statusCode}`);
  return (await runLine(pool, id, f.employee)).paye;
}
const codesOf = async (id: string, e: string) =>
  ((await runLine(pool, id, e)).validation_results as Array<{ code: string }>).map(c => c.code);

describe('BRK3', () => {
  it('January and February calculated, approved concurrently: exactly one is refused; recalculating it completes the year', async () => {
    const a = await seedEmployee(pool, fixtures, 'race ideal', 20_000);
    await setSalary(pool, a, 2027, 1, 60_000);
    let ideal = 0;
    for (const p of PERIODS) ideal += await calcApprove(a, await mk(a, p.year, p.month));
    for (let i = 0; i < 5; i++) {
      const f = await seedEmployee(pool, fixtures, 'race ' + i, 20_000);
      await setSalary(pool, f, 2027, 1, 60_000);
      const ids: string[] = [];
      for (const p of PERIODS) ids.push(await mk(f, p.year, p.month));
      for (const id of ids.slice(0, 10)) await calcApprove(f, id);
      await calcOnly(f, ids[10]!); await calcOnly(f, ids[11]!);
      const rs = await Promise.all([approveRun(f, ids[10]!), approveRun(f, ids[11]!)]);
      // Serialised by the company approval lock: whichever lands second sees the other and is refused
      // (an earlier month approved after it was calculated, or a later one). Exactly one is approved.
      expect(rs.map(r => r.statusCode).sort(), `attempt ${i}`).toEqual([200, 400]);
      for (const r of rs.filter(x => x.statusCode === 400)) expect(JSON.stringify(r.body)).toMatch(/paye_year_to_date_stale|Recalculate the run/);
      // The refused one, recalculated and approved, completes the year at its liability.
      const pending = rs[0]!.statusCode === 400 ? ids[10]! : ids[11]!;
      await calcApprove(f, pending);
      let sum = 0;
      for (const id of ids) sum += (await runLine(pool, id, f.employee)).paye;
      if (pending === ids[11]!) {
        expect(Math.round(sum * 100) / 100, `attempt ${i}`).toBe(Math.round(ideal * 100) / 100);
      } else {
        // February went first: January, recalculated, is approved with the warning naming February.
        const codes = ((await runLine(pool, ids[10]!, f.employee)).validation_results as Array<{ code: string }>).map(c => c.code);
        expect(codes, `attempt ${i}`).toContain('PAYE_LATER_PERIODS_APPROVED');
      }
    }
  });
});
