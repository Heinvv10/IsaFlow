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
  approveRun, reopenRun, cleanSeveranceFixtures, runLine, type SeveranceFixture,
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
  it('Dec reopened + changed while Jan/Feb are only calculated; Jan, Feb, Dec approved in that order', async () => {
    const a = await seedEmployee(pool, fixtures, 'brk5 ideal', 20_000);
    await setSalary(pool, a, 2026, 12, 80_000);
    let ideal = 0;
    for (const p of PERIODS) ideal += await calcApprove(a, await mk(a, p.year, p.month));

    const f = await seedEmployee(pool, fixtures, 'brk5', 20_000);
    let total = 0;
    const ids: string[] = [];
    for (const p of PERIODS) ids.push(await mk(f, p.year, p.month));
    for (const id of ids.slice(0, 10)) total -= 0, await calcApprove(f, id);
    await calcOnly(f, ids[10]!); await calcOnly(f, ids[11]!);
    await setSalary(pool, f, 2026, 12, 80_000);
    // setSalary above ends the open row from 2026-12-01; Dec reopened and recalculated
    expect((await reopenRun(f, ids[9]!)).statusCode).toBe(200);
    await calcOnly(f, ids[9]!);
    const r1 = await approveRun(f, ids[10]!);
    const r2 = await approveRun(f, ids[11]!);
    const r3 = await approveRun(f, ids[9]!);
    const refused = [r1, r2, r3].some(r => r.statusCode !== 200);
    let sum = 0;
    for (const id of ids) sum += (await runLine(pool, id, f.employee)).paye;
    const warned = (await Promise.all(ids.map(id => codesOf(id, f.employee)))).flat().includes('PAYE_LATER_PERIODS_APPROVED');
    console.warn("DIAG", [r1,r2,r3].map(r=>r.statusCode+":"+JSON.stringify(r.body).slice(0,160)), warned, ideal-sum);
    expect(refused || warned || Math.abs(sum - ideal) < 0.005, `short ${ideal - sum}; statuses ${[r1, r2, r3].map(r => r.statusCode)}`).toBe(true);
  });

  it('Jan and Feb calculated, approved CONCURRENTLY: one refused or total right', async () => {
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
      const both = rs.every(r => r.statusCode === 200);
      let sum = 0;
      for (const id of ids) sum += (await runLine(pool, id, f.employee)).paye;
      if (both) expect(Math.abs(sum - ideal) < 0.005, `both approved, short ${ideal - sum}`).toBe(true);
    }
  });
});
