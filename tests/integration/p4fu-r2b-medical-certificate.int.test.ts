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
 *   IRP5, 4116 = 2 x 752 = 1 504.00, 4005 = 6 000. With its latest line's
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
const fx: Record<'a' | 'b' | 'c', SeveranceFixture> = {} as never;
const runs: Record<'a' | 'b' | 'c', string[]> = { a: [], b: [], c: [] };

const SARS_PROFILE = `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
  sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
  physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`;

async function seed(name: string, monthly: number, beneficiaries: number, medicalAid: number, months: number[]): Promise<{ f: SeveranceFixture; runs: string[] }> {
  const f = await seedRetrenchedEmployee(pool, '2027-02-28', name, monthly);
  await pool.query(SARS_PROFILE, [f.company]);
  await pool.query(
    `UPDATE payroll_employees SET status = 'active', medical_aid_main_member = true, medical_aid_dependants_count = $2 WHERE id = $1`,
    [f.employee, beneficiaries - 1]);
  if (medicalAid > 0) {
    const comp = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Medical aid', '4005', 'deduction', false) RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')`,
      [f.employee, comp, medicalAid]);
  }
  const ids: string[] = [];
  for (const month of months) {
    const id = await createRunFor(f, month);
    await calculateRun(f, id);
    expect((await approveRun(f, id)).statusCode).toBe(200);
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
  ({ f: fx.c, runs: runs.c } = await seed('R3 cert C: taxed', 30_000, 2, 3_000, [3, 4]));
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
});
