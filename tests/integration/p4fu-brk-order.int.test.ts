/**
 * PAYE 4a follow-ups G4, breaker round 1 on PR B, ported: months approved out
 * of order. PAYE is cumulative over the declarable months BEFORE a run, so a
 * January calculated after February was approved leaves February's PAYE short
 * of January, and with nothing after February the year stays short (R340
 * here). Not refused (a back-fill or a correction of an earlier month must
 * stay possible; a paid run cannot be reopened): the late month's lines carry
 * PAYE_LATER_PERIODS_APPROVED, naming the later months and the remedy.
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
async function calcApprove(f: SeveranceFixture, id: string): Promise<number> {
  const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
  if (calc.statusCode !== 200) throw new Error(`calc ${calc.statusCode}`);
  const ok = await approveRun(f, id);
  if (ok.statusCode !== 200) throw new Error(`approve ${ok.statusCode}`);
  return (await runLine(pool, id, f.employee)).paye;
}

describe('G4: months approved out of order', () => {
  it('January approved after February: the January line warns, naming February; the shortfall is the R340 the warning describes', async () => {
    const inOrderEmployee = await seedEmployee(pool, fixtures, 'P4fu order: in order', 20_000);
    await setSalary(pool, inOrderEmployee, 2027, 1, 60_000);
    // Every month's run exists (as a draft) before the first is calculated: a later DRAFT must not warn.
    const inOrderIds: string[] = [];
    for (const p of PERIODS) inOrderIds.push(await mk(inOrderEmployee, p.year, p.month));
    let inOrder = 0;
    for (const id of inOrderIds) inOrder += await calcApprove(inOrderEmployee, id);
    const codes = async (id: string, employee: string) =>
      ((await runLine(pool, id, employee)).validation_results as Array<{ code: string; message: string }>);
    for (const id of inOrderIds) expect((await codes(id, inOrderEmployee.employee)).map(c => c.code)).not.toContain('PAYE_LATER_PERIODS_APPROVED');

    const f = await seedEmployee(pool, fixtures, 'P4fu order: January late', 20_000);
    await setSalary(pool, f, 2027, 1, 60_000);
    // A second employee who leaves at the end of January has no line in February: no warning for them.
    const leaver = (await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, end_date, date_of_birth, tax_number)
       VALUES ($1, 'W301-2', 'Lee', 'Leaver', '2020-01-01', '2027-01-31', '1980-01-01', '0123456780') RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
       SELECT $1, c.id, 20000, '2020-01-01' FROM payroll_components c WHERE c.company_id = $2 AND c.sars_source_code = '3601'`,
      [leaver, f.company]);
    const ids: Record<string, string> = {};
    for (const p of PERIODS) ids[`${p.year}-${p.month}`] = await mk(f, p.year, p.month);
    let total = 0;
    for (const p of PERIODS) if (p.month !== 1) total += await calcApprove(f, ids[`${p.year}-${p.month}`]!);
    total += await calcApprove(f, ids['2027-1']!);
    const warning = (await codes(ids['2027-1']!, f.employee)).find(c => c.code === 'PAYE_LATER_PERIODS_APPROVED');
    expect(warning?.message).toMatch(/2027-02/);
    expect((await codes(ids['2027-1']!, leaver)).map(c => c.code)).not.toContain('PAYE_LATER_PERIODS_APPROVED');
    expect(Math.round((inOrder - total) * 100) / 100).toBe(340);
  });

  it('January and February both calculated before either is approved: February\'s approval is refused until recalculated, then the year is whole', async () => {
    const f = await seedEmployee(pool, fixtures, 'P4fu order: both calculated', 20_000);
    await setSalary(pool, f, 2027, 1, 60_000);
    const ids: Record<string, string> = {};
    for (const p of PERIODS) ids[`${p.year}-${p.month}`] = await mk(f, p.year, p.month);
    let total = 0;
    for (const p of PERIODS.slice(0, 10)) total += await calcApprove(f, ids[`${p.year}-${p.month}`]!);
    const jan = ids['2027-1']!;
    const feb = ids['2027-2']!;
    for (const id of [jan, feb]) {
      const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
      expect(calc.statusCode).toBe(200);
    }
    expect((await approveRun(f, jan)).statusCode).toBe(200);
    total += (await runLine(pool, jan, f.employee)).paye;
    const refused = await approveRun(f, feb);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/2027-01.*Recalculate the run/);
    total += await calcApprove(f, feb);
    // R20 000 × 10 + R60 000 × 2 = R320 000: tax(320 000) = 45 772, the whole year's liability (no shortfall).
    expect(Math.round(total * 100) / 100).toBe(45_772);
  });

  it('January and February both calculated, February approved first (what a concurrent approval lands as): January is refused until recalculated, then carries the warning', async () => {
    const f = await seedEmployee(pool, fixtures, 'P4fu order: February first', 20_000);
    await setSalary(pool, f, 2027, 1, 60_000);
    const ids: Record<string, string> = {};
    for (const p of PERIODS) ids[`${p.year}-${p.month}`] = await mk(f, p.year, p.month);
    for (const p of PERIODS.slice(0, 10)) await calcApprove(f, ids[`${p.year}-${p.month}`]!);
    const jan = ids['2027-1']!;
    const feb = ids['2027-2']!;
    for (const id of [jan, feb]) expect((await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id)).statusCode).toBe(200);
    expect((await approveRun(f, feb)).statusCode).toBe(200);
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/later month.*2027-02.*Recalculate the run/);
    await calcApprove(f, jan);
    const lines = (await runLine(pool, jan, f.employee)).validation_results as Array<{ code: string }>;
    expect(lines.map(c => c.code)).toContain('PAYE_LATER_PERIODS_APPROVED');
  });
});
