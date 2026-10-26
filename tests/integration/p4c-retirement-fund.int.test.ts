/**
 * PAYE 4c: employee retirement fund contributions through the real routes on
 * real Postgres. Rules and sources: retirementFund.ts and payeCumulative.ts
 * (s11F; SARS PAYE-GEN-01-G21 (2027) p. 10-11, R430 000 for 2027); e@syFile
 * 4001/4003/4006 per BRS V25.3.0 p. 101-102 (easyFileRetirementFields).
 * Hand figures: tests/unit/services/payroll/payeRetirementFund.test.ts.
 *
 * Employees A and C are a real employer's payroll (numbers only) against what
 * its Sage payroll deducted: A 12 440.51 a month, C 4 681.01 then 1 886.49.
 * IsaFlow's 12 440.49 / 4 681.00 / 1 886.48 differ by Sage's day-based
 * annualisation, which shows on employees with no retirement fund or medical
 * aid as well (see the PR).
 *
 * Also the assign_employee_component date fix: a once-off dated the 1st is
 * stored on the 1st and paid in its month (it was stored a day early in SAST).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import { assignEmployeeComponentTool } from '../../src/lib/mcp/tools/writeEmployees';
import type { McpToolContext } from '../../src/lib/mcp/types';
import { approveRun, calculateRun, cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee, setSalary } from './p4fu-cumulative.helpers';
import createRun from '../../pages/api/payroll/runs';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

/** An employee on `monthly`, with `beneficiaries` on medical aid, a 2175 account (deductions) and SARS details. */
async function employee(name: string, monthly: number, beneficiaries: number): Promise<SeveranceFixture> {
  const f = await seedEmployee(pool, fixtures, name, monthly);
  await pool.query(
    `UPDATE payroll_employees SET medical_aid_main_member = $2, medical_aid_dependants_count = $3 WHERE id = $1`,
    [f.employee, beneficiaries > 0, Math.max(0, beneficiaries - 1)]);
  await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [f.company]);
  await pool.query(`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
    sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
    physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`, [f.company]);
  return f;
}

async function component(f: SeveranceFixture, name: string, code: string, type: 'earning' | 'deduction'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [f.company, name, code, type, type === 'earning'])).rows[0]!.id;
}

/** The retirement annuity (4006) of `amount` a month from `from`, assigned through the employee components route. */
async function annuity(f: SeveranceFixture, amount: number, from: string): Promise<void> {
  const componentId = await component(f, 'Retirement annuity', '4006', 'deduction');
  const r = await f.call(components as Route, 'POST', `/api/payroll/employees/${f.employee}/components`, f.employee,
    { body: { componentId, amount, effectiveFrom: from } });
  expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
}

async function pay(f: SeveranceFixture, year: number, month: number, approve = true) {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  await calculateRun(f, id);
  if (approve) expect((await approveRun(f, id)).statusCode).toBe(200);
  return (await pool.query(
    `SELECT paye::float8 AS paye, taxable_income::float8 AS taxable, periodic_taxable::float8 AS periodic,
            retirement_contributions::float8 AS contributions, retirement_deduction::float8 AS deduction,
            net_pay::float8 AS net, component_breakdown
       FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [id, f.employee])).rows[0]!;
}

async function certificateLines(f: SeveranceFixture): Promise<string[]> {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
  req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
  req.query = { taxYear: '2027' };
  const out = response();
  let file = '';
  out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
  await (easyfile as Route)(req as never, out.res as never);
  expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
  return file.split(/\r\n/);
}

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('PAYE 4c: the deduction month by month', () => {
  it('employee A: R60 000, RA R2 708.59, four beneficiaries: 12 440.49 a month; 4006 on the certificate', async () => {
    const f = await employee('P4c employee A', 60_000, 4);
    await annuity(f, 2_708.59, '2026-03-01');
    const months = [];
    for (const month of [3, 4, 5]) months.push(await pay(f, 2026, month));
    expect(months.map(m => m.paye)).toEqual([12_440.49, 12_440.49, 12_440.49]);
    expect(months[2]).toMatchObject({ periodic: 60_000, taxable: 57_291.41, contributions: 2_708.59, deduction: 2_708.59 });
    // Paid through payroll: 60 000 − 2 708.59 − 12 440.49 − UIF 177.12.
    expect(months[2]!.net).toBe(44_673.8);
    const lines = await certificateLines(f);
    expect(lines).toContain('4006,8125'); // 3 × 2 708.59 = 8 125.77, cents dropped
    expect(lines.some(l => /^4(001|003),/.test(l))).toBe(false);
  });

  it('employee C: April without RA, then RA R1 055.83 and four beneficiaries from May: 4 681.00, 1 886.48', async () => {
    const f = await employee('P4c employee C', 30_000, 0);
    const april = await pay(f, 2026, 4);
    await annuity(f, 1_055.83, '2026-05-01');
    await pool.query('UPDATE payroll_employees SET medical_aid_main_member = true, medical_aid_dependants_count = 3 WHERE id = $1', [f.employee]);
    const may = await pay(f, 2026, 5);
    expect([april.paye, may.paye]).toEqual([4_681, 1_886.48]);
    expect([april.contributions, may.contributions]).toEqual([0, 1_055.83]);
  });

  it('annualised through the stored year to date: a pay rise in June trues up the capped months (3 735)', async () => {
    const f = await employee('P4c annualised cap', 20_000, 0);
    await annuity(f, 8_000, '2026-03-01');
    await setSalary(pool, f, 2026, 6, 40_000);
    const months = [];
    for (const month of [3, 4, 5, 6]) months.push(await pay(f, 2026, month));
    expect(months.map(m => m.paye)).toEqual([1_125, 1_125, 1_125, 3_735]);
    expect(months.map(m => m.deduction)).toEqual([5_500, 5_500, 5_500, 11_000]);
  });
});

describe('PAYE 4c: assign_employee_component stores a date-only value as given', () => {
  it('a once-off dated 2026-10-01 is stored on the 1st, closes on the 31st and is paid in October', async () => {
    const f = await employee('P4c once-off date', 20_000, 0);
    const allowance = await component(f, 'Once-off allowance', '3713', 'earning');
    const ctx = { userId: f.admin, companyId: f.company, scopes: ['write:payroll'], companyRole: 'owner', tokenJti: null, oauthAppId: null } as unknown as McpToolContext;
    const r = await assignEmployeeComponentTool.handler({
      employee_id: f.employee, component_id: allowance, amount: 1_000, effective_from: '2026-10-01', is_recurring: false, idempotency_key: crypto.randomUUID(),
    }, ctx);
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    const row = (await pool.query(
      `SELECT effective_from::text AS f, effective_to::text AS t FROM payroll_employee_components WHERE component_id = $1`, [allowance])).rows[0]!;
    expect(row).toEqual({ f: '2026-10-01', t: '2026-10-31' });
    const october = await pay(f, 2026, 10, false);
    expect((october.component_breakdown as Array<{ componentId: string }>).map(i => i.componentId)).toContain(allowance);
  });
});
