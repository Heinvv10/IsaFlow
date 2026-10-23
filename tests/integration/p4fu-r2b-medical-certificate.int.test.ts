/**
 * PAYE 4a follow-ups round 2, R3 (Hein 2026-10-23, option A), real routes and
 * real Postgres: the e@syFile certificate reports 4005 / 4116 from the run
 * lines, and a certificate whose tax the medical credit wiped is an IT3(a)
 * with reason 08. Rules: SARS BRS V25.3.0 p. 52-53, 59-61, 101, 108 (see
 * src/modules/accounting/services/payroll/easyFileMedicalFields.ts).
 *
 * Figures, 2027 (G21 2027 p. 3, 10-11), born 1980 (under 65):
 * - A: R13 000 a month, member + 3 dependants, R2 000 a month medical aid
 *   (deduction coded 4005), March to October. tax(156 000) = 28 080 - 17 820
 *   = 10 260 < the credit (376 x 2 + 254 x 2) x 12 = 15 120, so PAYE is nil and
 *   10 260 / 12 = 855 of credit is used a month: 4116 = 8 x 855 = 6 840.00;
 *   4005 = 8 x 2 000 = 16 000. 3601 = 104 000 > the R99 000 threshold, so 02
 *   is not true: 08.
 * - B: the same pay and family, no medical aid deduction: refused, naming 4005.
 * - C: R30 000 a month, member + 1, R3 000 medical aid, March and April: an
 *   IRP5, 4116 = 2 x 752 = 1 504.00, 4005 = 6 000 (an R500 non-deduction
 *   component coded 4005 is not the employee's fees, here or in a line's
 *   breakdown). With its latest line's
 *   record removed (a month calculated before migration 926) the three fields
 *   are left off and the export says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import type { Route } from './w3-01-payroll.helpers';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';
import {
  approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
type Key = 'a' | 'b' | 'c' | 'd' | 'at65' | 'at64' | 'noDob';
const fx: Record<Key, SeveranceFixture> = {} as never;
const runs: Record<Key, string[]> = { a: [], b: [], c: [], d: [], at65: [], at64: [], noDob: [] };

const SARS_PROFILE = `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
  sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
  physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`;

async function seed(
  name: string, monthly: number, beneficiaries: number, medicalAid: number, months: number[], otherCoded4005 = 0,
  person: { born: string | null; idNumber: string } = { born: '1980-01-01', idNumber: '8001015009087' },
): Promise<{ f: SeveranceFixture; runs: string[] }> {
  const f = await seedRetrenchedEmployee(pool, '2027-02-28', name, monthly);
  await pool.query('UPDATE payroll_employees SET date_of_birth = $2::date, id_number = $3 WHERE id = $1', [f.employee, person.born, person.idNumber]);
  await pool.query(SARS_PROFILE, [f.company]);
  await pool.query(
    `UPDATE payroll_employees SET status = 'active', medical_aid_main_member = true, medical_aid_dependants_count = $2 WHERE id = $1`,
    [f.employee, beneficiaries - 1]);
  if (medicalAid > 0) {
    // A voluntary deduction is owed to the scheme: approval posts it to 2175 (payrollJournalBuilder).
    await pool.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
       VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [f.company]);
    const comp = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Medical aid', '4005', 'deduction', false) RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')`,
      [f.employee, comp, medicalAid]);
  }
  if (otherCoded4005 > 0) {
    // A component coded 4005 that is not a deduction is not the employee's fees (the calculator counts
    // deductions only). An employer contribution cannot be stored at all: component_type is VARCHAR(20)
    // and 'employer_contribution' is 21 characters, so this is a (non-taxable) earning mis-coded 4005.
    const comp = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Medical aid allowance', '4005', 'earning', false) RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')`,
      [f.employee, comp, otherCoded4005]);
  }
  const ids: string[] = [];
  for (const month of months) {
    const id = await createRunFor(f, month);
    await calculateRun(f, id);
    const approved = await approveRun(f, id);
    expect(approved.statusCode, `${name} month ${month}: ${JSON.stringify(approved.body)}`).toBe(200);
    ids.push(id);
  }
  return { f, runs: ids };
}

async function exportFile(f: SeveranceFixture): Promise<{ status: number; file: string; warnings: string[]; body: unknown }> {
  const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as {
    url: string; query: Record<string, unknown>;
  };
  req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
  req.query = { taxYear: '2027' };
  const out = response();
  let file = '';
  out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
  await (easyfile as Route)(req as never, out.res as never);
  const raw = out.headers.get('x-isaflow-warnings');
  return { status: out.state.statusCode, file, body: out.state.body, warnings: raw ? JSON.parse(decodeURIComponent(String(raw))) as string[] : [] };
}

const employeeRecord = (file: string): string[] => {
  const lines = file.split(/\r\n/);
  const start = lines.findIndex(l => l.startsWith('3010,'));
  return lines.slice(start, lines.indexOf('9999,9999', start) + 1);
};

beforeAll(async () => {
  const eight = [3, 4, 5, 6, 7, 8, 9, 10];
  ({ f: fx.a, runs: runs.a } = await seed('R3 cert A: credit wipes the tax', 13_000, 4, 2_000, eight));
  ({ f: fx.b, runs: runs.b } = await seed('R3 cert B: no 4005', 13_000, 4, 0, eight));
  ({ f: fx.c, runs: runs.c } = await seed('R3 cert C: taxed', 30_000, 2, 3_000, [3, 4], 500));
  ({ f: fx.d, runs: runs.d } = await seed('R3 cert D: credit, no 4005', 30_000, 2, 0, [3, 4]));
  ({ f: fx.at65, runs: runs.at65 } = await seed('R3 cert 65 on 28 Feb', 30_000, 2, 5_100, [3], 0, { born: '1962-02-28', idNumber: '6202285009087' }));
  ({ f: fx.at64, runs: runs.at64 } = await seed('R3 cert 65 on 1 Mar', 30_000, 2, 5_100, [3], 0, { born: '1962-03-01', idNumber: '6203015009087' }));
  ({ f: fx.noDob, runs: runs.noDob } = await seed('R3 cert no DOB', 30_000, 2, 0, [3], 0, { born: null, idNumber: '5806155009087' }));
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, Object.values(fx).filter(Boolean)); } finally { await pool.end(); }
});

describe('R3: medical fields on the e@syFile certificate', () => {
  it('A: the lines record nil PAYE, 855 of credit and the R2 000 fees each month', async () => {
    const lines = (await pool.query(
      `SELECT l.paye::float8 AS paye, l.medical_credit::float8 AS credit, l.medical_scheme_fees::float8 AS fees
         FROM payroll_run_lines l WHERE l.run_id = ANY($1)`, [runs.a])).rows;
    expect(lines).toHaveLength(8);
    expect(lines.every(l => l.paye === 0 && l.credit === 855 && l.fees === 2_000), JSON.stringify(lines)).toBe(true);
  });

  it('A: an IT3(a) with reason 08, 4005 = 16 000 and 4116 = 6 840.00, valid by the BRS rules', async () => {
    const out = await exportFile(fx.a);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const fields = employeeRecord(out.file);
    for (const want of ['3015,"IT3(a)"', '3601,104000', '4005,16000', '4116,6840.00', '4150,08']) expect(fields, want).toContain(want);
    expect(fields.filter(l => /^(4102|4115|4120),/.test(l))).toEqual([]);
    expect(validateCertificateTaxFields(fields)).toEqual([]);
  });

  it('B: the same nil tax with no medical aid deduction is still refused, naming 4005', async () => {
    const out = await exportFile(fx.b);
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(out.body)).toMatch(/4005/);
    expect(out.file).toBe('');
  });

  it('C: an IRP5 carries 4005 = 6 000 and 4116 = 1 504.00 beside its PAYE', async () => {
    const out = await exportFile(fx.c);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const fields = employeeRecord(out.file);
    for (const want of ['3015,"IRP5"', '4005,6000', '4116,1504.00']) expect(fields, want).toContain(want);
    expect(validateCertificateTaxFields(fields)).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('C: when the latest month carries no record (calculated before migration 926), the fields are left off with a warning', async () => {
    await pool.query('UPDATE payroll_run_lines SET medical_credit = NULL, medical_scheme_fees = NULL WHERE run_id = $1', [runs.c[1]]);
    const out = await exportFile(fx.c);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const fields = employeeRecord(out.file);
    expect(fields.filter(l => /^(4005|4116|4120),/.test(l))).toEqual([]);
    expect(out.warnings).toEqual([expect.stringMatching(/4005.*before IsaFlow recorded the credits/)]);
  });

  it('C: a line before migration 926 still counts its 4005 fees, from its breakdown, when a later line is recorded', async () => {
    await pool.query(
      'UPDATE payroll_run_lines SET medical_credit = 1504, medical_scheme_fees = 3000 WHERE run_id = $1', [runs.c[1]]);
    await pool.query('UPDATE payroll_run_lines SET medical_credit = NULL, medical_scheme_fees = NULL WHERE run_id = $1', [runs.c[0]]);
    const fields = employeeRecord((await exportFile(fx.c)).file);
    expect(fields).toContain('4005,6000');
    expect(fields).toContain('4116,1504.00');
  });

  it('D: PAYE took the MTC but no 4005 is deducted: no 4005/4116, and a warning naming the employee and the credit', async () => {
    const out = await exportFile(fx.d);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(employeeRecord(out.file).filter(l => /^(4005|4116|4120),/.test(l))).toEqual([]);
    expect(out.warnings).toEqual([expect.stringMatching(/^Wanda Test: .*R1504\.00.*4005/)]);
  });

  it('65 on the last day of the year (28 Feb 1962): the credit in PAYE and 4120; 1 Mar 1962: neither', async () => {
    const paye = async (key: Key) => (await pool.query('SELECT paye::float8 AS paye FROM payroll_run_lines WHERE run_id = $1', [runs[key][0]])).rows[0]!.paye;
    // 30 000: 37 383 a year for 65+ with member + 1 (3 115.25); less the 11 364.624 credit: 2 168.20. 64: 47 148 / 12 = 3 929.
    expect([await paye('at65'), await paye('at64')]).toEqual([2_168.2, 3_929]);
    const medical = async (key: Key) => employeeRecord((await exportFile(fx[key])).file).filter(l => /^(4005|4116|4120),/.test(l));
    expect(await medical('at65')).toEqual(['4005,5100', '4116,752.00', '4120,947.05']);
    expect(await medical('at64')).toEqual(['4005,5100', '4116,752.00']);
  });

  it('no date of birth but a 1958 ID number: PAYE took none of the 65+ rebates, and the export says so', async () => {
    const out = await exportFile(fx.noDob);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    // (Member + 1 with no 4005 deduction: the no-4005 warning too.)
    expect(out.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Wanda Test: no date of birth.*68/)]));
    expect(out.warnings).toHaveLength(2);
  });
});

