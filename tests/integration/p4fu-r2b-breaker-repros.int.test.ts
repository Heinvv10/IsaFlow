/**
 * Breaker repros for PAYE 4a round 2 PR B (a917e75bc), ported from
 * /home/hein/Workspace/.brkR2B. Real routes, real PG. 1 passed at a917e75bc
 * and stays as a guard; 2 and 3 were fixed in review round 1 (POST refuses an
 * inactive employee; employee_name is the employee record's).
 *
 * 1. Legacy lines (pre-926, medical_* NULL): May's PAYE for a 65+ fee payer
 *    must equal the PAYE it gets when March/April carry their records, and
 *    May's record must carry March/April's credit (payeCumulative header).
 *    The certificate must then report the same 4005/4116/4120.
 * 2. Directive POST for an 'inactive' employee (the picker never offers one).
 * 3. Directive POST whose employee_name is another person's name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import directives from '../../pages/api/accounting/tax-directives';
import type { Route } from './w3-01-payroll.helpers';
import {
  approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx: SeveranceFixture[] = [];

async function seed65(name: string): Promise<{ f: SeveranceFixture; runs: string[] }> {
  const f = await seedRetrenchedEmployee(pool, '2027-02-28', name, 30_000);
  fx.push(f);
  await pool.query(`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
    sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
    physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`, [f.company]);
  await pool.query(
    `UPDATE payroll_employees SET status = 'active', date_of_birth = '1959-06-15', id_number = '5906155009084',
            medical_aid_main_member = true, medical_aid_dependants_count = 1 WHERE id = $1`, [f.employee]);
  await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [f.company]);
  const comp = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1, 'Medical aid', '4005', 'deduction', false) RETURNING id`, [f.company])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 5100, '2020-01-01')`,
    [f.employee, comp]);
  const runs: string[] = [];
  for (const month of [3, 4]) {
    const id = await createRunFor(f, month);
    await calculateRun(f, id);
    expect((await approveRun(f, id)).statusCode).toBe(200);
    runs.push(id);
  }
  return { f, runs };
}

async function may(f: SeveranceFixture) {
  const id = await createRunFor(f, 5);
  await calculateRun(f, id);
  expect((await approveRun(f, id)).statusCode).toBe(200);
  return (await pool.query(
    `SELECT paye::float8 AS paye, medical_credit::float8 AS mc, additional_medical_credit::float8 AS amc,
            medical_scheme_fees::float8 AS fees FROM payroll_run_lines WHERE run_id = $1`, [id])).rows[0]!;
}

async function certificate(f: SeveranceFixture): Promise<string[]> {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as {
    url: string; query: Record<string, unknown>;
  };
  req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
  req.query = { taxYear: '2027' };
  const out = response();
  let file = '';
  out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
  await (easyfile as Route)(req as never, out.res as never);
  expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
  return file.split(/\r\n/).filter(l => /^(4005|4116|4120|4102),/.test(l));
}

let recorded: { f: SeveranceFixture; runs: string[] };
let legacy: { f: SeveranceFixture; runs: string[] };

beforeAll(async () => {
  recorded = await seed65('BRK R2B recorded');
  legacy = await seed65('BRK R2B legacy');
  // Simulate March/April calculated before migration 926.
  await pool.query(
    `UPDATE payroll_run_lines SET medical_credit = NULL, additional_medical_credit = NULL, medical_scheme_fees = NULL
      WHERE run_id = ANY($1)`, [legacy.runs]);
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fx); } finally { await pool.end(); }
});

describe('REPRO 1: legacy (pre-926) lines feed May exactly as recorded ones do', () => {
  it('May PAYE equal; May record carries March/April; certificates equal', async () => {
    const before = (await pool.query(
      `SELECT SUM(medical_credit)::float8 AS mc, SUM(additional_medical_credit)::float8 AS amc
         FROM payroll_run_lines WHERE run_id = ANY($1)`, [recorded.runs])).rows[0]!;
    expect(before.amc, 'the fixture must exercise the 65+ credit').toBeGreaterThan(0);
    const a = await may(recorded.f);
    const b = await may(legacy.f);
    expect(b.paye).toBe(a.paye);
    expect(b.fees).toBe(a.fees);
    expect(b.mc).toBeCloseTo(a.mc + before.mc, 2);
    expect(b.amc).toBeCloseTo(a.amc + before.amc, 2);
    expect(await certificate(legacy.f)).toEqual(await certificate(recorded.f));
  });
});

describe('REPRO 2/3: directive create', () => {
  const BODY = { directive_type: 'severance', amount: 10_000, tax_rate: 0.1, effective_date: '2026-05-01' };

  it('an inactive employee (never offered by the picker) is refused', async () => {
    const f = fx[0]!;
    const inactive = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status, medical_aid_main_member)
       VALUES ($1, 'BRK-I', 'Not', 'Paid', '2021-01-01', 'inactive', true) RETURNING id`, [f.company])).rows[0]!.id;
    const r = await f.call(directives as Route, 'POST', '/api/accounting/tax-directives', undefined,
      { body: { ...BODY, employee_id: inactive, employee_name: 'Not Paid' } });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
  });

  it('employee_name naming someone other than employee_id is overwritten with the record\'s name', async () => {
    const f = fx[0]!;
    const r = await f.call(directives as Route, 'POST', '/api/accounting/tax-directives', undefined,
      { body: { ...BODY, employee_id: f.employee, employee_name: 'Somebody Else Entirely' } });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    const row = (await pool.query(
      `SELECT d.employee_name, e.first_name || ' ' || e.last_name AS real FROM tax_directives d
         JOIN payroll_employees e ON e.id = d.employee_id WHERE d.id = $1`, [r.body.data!.id])).rows[0]!;
    expect(row.employee_name).toBe(row.real);
  });
});

describe('ROUND 2: the create fix (ported from the breaker, 4192b08d7)', () => {
  const BODY = { directive_type: 'severance', amount: 10_000, tax_rate: 0.1, effective_date: '2026-05-01' };
  const post = (f: SeveranceFixture, body: Record<string, unknown>) =>
    f.call(directives as Route, 'POST', '/api/accounting/tax-directives', undefined, { body });
  const stored = async (id: unknown) =>
    (await pool.query('SELECT employee_tax_number FROM tax_directives WHERE id = $1', [id])).rows[0]!.employee_tax_number;

  it('R2-A: a record with no tax number does not take one from the body: 201, stored NULL', async () => {
    const f = fx[0]!;
    await pool.query('UPDATE payroll_employees SET tax_number = NULL WHERE id = $1', [f.employee]);
    const r = await post(f, { ...BODY, employee_id: f.employee, employee_tax_number: '9999999999' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    expect(await stored(r.body.data!.id)).toBeNull();
  });

  it('R2-B: the record\'s own number written with spaces: 201, stored as the record has it', async () => {
    const f = fx[0]!;
    await pool.query("UPDATE payroll_employees SET tax_number = '0123456789' WHERE id = $1", [f.employee]);
    const r = await post(f, { ...BODY, employee_id: f.employee, employee_tax_number: '0123 456 789' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    expect(await stored(r.body.data!.id)).toBe('0123456789');
  });

  it('R2-C (guard): non-string employee_name / text / amount types cannot 500', async () => {
    const f = fx[0]!;
    for (const extra of [{ employee_name: { x: 1 } }, { notes: ['a'] }, { amount: 'abc' }, { amount: { n: 1 } }, { tax_rate: '0.1; drop' }]) {
      const r = await post(f, { ...BODY, employee_id: f.employee, ...extra });
      expect(r.statusCode, `${JSON.stringify(extra)} -> ${JSON.stringify(r.body)}`).toBeLessThan(500);
    }
  });

  it('R2-D (guard): the stored name is the record\'s', async () => {
    const f = fx[0]!;
    const made = await post(f, { ...BODY, employee_id: f.employee });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    expect(made.body.data!.employeeName).toBe((await pool.query(
      "SELECT first_name || ' ' || last_name AS n FROM payroll_employees WHERE id = $1", [f.employee])).rows[0]!.n);
  });
});

