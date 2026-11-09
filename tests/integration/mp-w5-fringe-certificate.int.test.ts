/**
 * Wave 5 FB review H1: the e@syFile certificate agrees with the PAYE withheld on a travel allowance, a company vehicle and
 * an employer medical contribution. 3601 excludes the cash 3701 (own code), 3802 and 3810 are non-cash codes, 4582 is the
 * part PAYE was withheld on (BRS V25.3.0 p. 105), 4474 equals 3810 (p. 103). Run lines are written as the calculator
 * stores them (payeInclusionRate / payeIncludedAmount in the breakdown). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import easyfileExport from '../../pages/api/payroll/irp5/easyfile-export';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();

const item = (code: string, amount: number, extra: Record<string, unknown> = {}) => ({
  componentId: code, componentName: code, sarsSourceCode: code, amount, isTaxable: true, isUifApplicable: false, ...extra,
});

beforeAll(async () => {
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO companies (id, name, paye_reference_number, sars_contact_first_name, sars_contact_last_name, sars_contact_telephone,
       physical_address_line1, physical_postal_code, physical_city)
     VALUES ($1, 'Fringe certificate', '7123456789', 'Ada', 'Lovelace', '0110000000', '1 Fixture Street', '0001', 'Pretoria')`, [company]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [company, user]);
  const emp = (await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
     VALUES ($1, 'F1', 'Test', 'Fringe', '2020-01-01', '1980-01-01', '8001015009087', '0123456789') RETURNING id`, [company])).rows[0]!.id;
  const run = (await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross) VALUES ($1, 3, 2026, 'approved', 0) RETURNING id`, [company])).rows[0]!.id;
  const items = [
    item('3601', 30_000),
    item('3701', 5_000, { payeInclusionRate: 0.8, payeIncludedAmount: 4_000 }),
    item('3802', 14_000, { isNonCash: true, payeInclusionRate: 0.8, payeIncludedAmount: 11_200 }),
    item('3810', 3_000, { isNonCash: true }),
  ];
  await pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, medical_scheme_fees, component_breakdown)
     VALUES ($1, $2, 35000, 49200, 9000, 177.12, 177.12, 0, 3000, $3::jsonb)`, [run, emp, JSON.stringify(items)]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)', [company]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally { await pool.end(); }
});

async function exportFile(): Promise<{ status: number; body: string; warnings: string[] }> {
  const token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'GET') as never as { url: string; query: Record<string, string> };
  req.url = '/api/payroll/irp5/easyfile-export';
  req.query = { taxYear: '2027' };
  const out = { status: 200, body: '', warnings: [] as string[] };
  const res = {
    status(code: number) { out.status = code; return res; },
    setHeader(name: string, value: string) {
      if (name === 'X-IsaFlow-Warnings') out.warnings = JSON.parse(decodeURIComponent(value)) as string[];
      return res;
    },
    getHeader() { return undefined; },
    json(b: unknown) { out.body = JSON.stringify(b); return res; },
    send(b: unknown) { out.body = String(b); return res; },
    end(b?: unknown) { if (b !== undefined) out.body = String(b); return res; },
  };
  await easyfileExport(req as never, res as never);
  return out;
}

describe('e@syFile certificate for 30 000 salary + 5 000 travel + a 14 000 vehicle + a 3 000 employer medical contribution', () => {
  it('3601 30 000, 3701 5 000, 3802 14 000, 3810 3 000, 4474 3 000 and 4582 15 200 (4 000 + 11 200)', async () => {
    const file = await exportFile();
    expect(file.status, file.body).toBe(200);
    const lines = file.body.split(/\r?\n/);
    expect(lines.filter((l) => /^(3601|3701|3802|3810|4474|4497|4582),/.test(l))).toEqual([
      '3601,30000', '3701,5000', '3802,14000', '3810,3000', '4474,3000', '4497,18200', '4582,15200',
    ]);
    expect(file.warnings.filter((w) => /4582/.test(w))).toEqual([]);
  });
});
