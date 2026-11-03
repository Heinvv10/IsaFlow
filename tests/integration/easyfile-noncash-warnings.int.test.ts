/**
 * The e@syFile export's warnings about 3801 items paid in cash (no isNonCash flag: runs costed
 * before the loan benefit was non-cash), and its rule for an employee with no income code to write.
 *  - Many such employees make ONE bounded warning (names and amounts, capped), pushed after every
 *    other warning, so it can never crowd the 3231 / 4005 / 4116 ones out of the capped header.
 *  - An employee whose every income code is under R1 (the writer drops the cents and leaves a nil
 *    field out) gets no certificate and a warning; the company's file is still written.
 * Disposable fixture DB only.
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
const LEGACY = 25;

const salary = (amount: number) => ({ componentId: 's', componentName: 'Basic Salary', sarsSourceCode: '3601', amount, isTaxable: true, isUifApplicable: true });
const fringe = (amount: number, nonCash: boolean) => ({
  componentId: 'f', componentName: 'Loan benefit', sarsSourceCode: '3801', amount, isTaxable: true, isUifApplicable: false, ...(nonCash ? { isNonCash: true } : {}),
});

async function employee(last: string, idNumber: string, dateOfBirth: string | null): Promise<string> {
  return (await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
     VALUES ($1, $2, 'Test', $2, '2020-01-01', $3, $4, '0123456789') RETURNING id`, [company, last, dateOfBirth, idNumber])).rows[0]!.id;
}

beforeAll(async () => {
  await pool.query(
    `INSERT INTO companies (id, name, paye_reference_number, sars_contact_first_name, sars_contact_last_name, sars_contact_telephone,
       physical_address_line1, physical_postal_code, physical_city)
     VALUES ($1, 'e@syFile non-cash warnings', '7123456789', 'Ada', 'Lovelace', '0110000000', '1 Fixture Street', '0001', 'Pretoria')`, [company]);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [company, user]);
  const run = (await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross) VALUES ($1, 3, 2026, 'approved', 0) RETURNING id`,
    [company])).rows[0]!.id;
  const line = (employeeId: string, gross: number, paye: number, items: unknown[]) => pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, component_breakdown) VALUES ($1, $2, $3, $3, $4, $5::jsonb)`,
    [run, employeeId, gross, paye, JSON.stringify(items)]);
  // Costed before the flag: the benefit inside gross pay, its 3801 item unflagged.
  for (let i = 1; i <= LEGACY; i += 1) {
    await line(await employee(`Legacy${String(i).padStart(2, '0')}`, '8001015009087', '1980-01-01'), 42_000, 8_000, [salary(41_000), fringe(1_000, false)]);
  }
  // 65+ by the ID number, no date of birth: a medical-rebate warning (easyFileMedicalFields).
  await line(await employee('Senior', '5001015009080', null), 20_000, 1_000, [salary(20_000)]);
  // Nothing but a 60c benefit: no income code the writer would write.
  await line(await employee('Tiny', '8001015009087', '1980-01-01'), 0, 0, [fringe(0.6, true)]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)', [company]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally {
    await pool.end();
  }
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

describe('e@syFile export: 3801 paid in cash, and an employee with nothing to certify', () => {
  it('says the 3801 items paid in cash in ONE bounded warning, after the others', async () => {
    const file = await exportFile();
    expect(file.status, file.body).toBe(200);
    const inCash = file.warnings.filter((w) => /3801/.test(w) && /3601/.test(w));
    expect(inCash).toHaveLength(1);
    expect(file.warnings.at(-1)).toBe(inCash[0]);
    expect(file.warnings.some((w) => /Senior.*65\+ rebates/.test(w))).toBe(true);
    const summary = inCash[0]!;
    expect(summary).toMatch(/25 employees/);
    expect(summary).toMatch(/Test Legacy01 \(R.?1.?000\.00\)/);
    expect(summary).toMatch(/and 15 more/);
    expect(summary).not.toMatch(/Legacy25/);
    expect(summary.length).toBeLessThan(800);
  });

  it('writes no certificate for an employee whose every income code is under R1, says so, and still writes the file', async () => {
    const file = await exportFile();
    expect(file.status, file.body).toBe(200);
    expect(file.body).not.toMatch(/Tiny/);
    expect(file.body.split(/\r?\n/).filter((l) => l.startsWith('3010,'))).toHaveLength(LEGACY + 1);
    expect(file.warnings.some((w) => /Test Tiny.*under R1/.test(w))).toBe(true);
  });
});
