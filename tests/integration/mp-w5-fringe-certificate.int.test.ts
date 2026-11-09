/**
 * Wave 5 FB review H1: the e@syFile certificate agrees with the PAYE withheld on a travel allowance, a company vehicle and
 * an employer medical contribution. 3601 excludes the cash 3701 (own code), 3802 and 3810 are non-cash codes, 4582 is the
 * part PAYE was withheld on (BRS V25.3.0 p. 105), 4474 equals 3810 (p. 103). Run lines are written as the calculator
 * stores them (payeInclusionRate / payeIncludedAmount in the breakdown). Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { listRunAllowanceFiling } from '../../src/modules/accounting/services/payroll/payrollAllowanceFiling';
import easyfileExport from '../../pages/api/payroll/irp5/easyfile-export';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
let runId = '';
let f2 = '';

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
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, medical_scheme_fees, medical_credit, additional_medical_credit, component_breakdown)
     VALUES ($1, $2, 35000, 49200, 9000, 177.12, 177.12, 0, 3000, 752, 0, $3::jsonb)`, [run, emp, JSON.stringify(items)]);
  // F2: a NON-TAXABLE cash 3701 and a hand-assigned CASH 3802 (no flag, no rate): neither is part of the 4582 portion.
  f2 = (await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
     VALUES ($1, 'F2', 'Test', 'Zed', '2020-01-01', '1980-01-01', '8001015009087', '0123456789') RETURNING id`, [company])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
     VALUES ($1, $2, 33000, 32000, 5000, 177.12, 177.12, 0, $3::jsonb)`, [run, f2, JSON.stringify([
      item('3601', 30_000), item('3701', 1_000, { isTaxable: false }), item('3802', 2_000),
    ])]);
  runId = run;
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

/** One employee's certificate lines (a record runs from its 3010 to the next). */
function recordOf(body: string, surname: string): string[] {
  const records = body.split(/\r?\n/).reduce<string[][]>((acc, l) => { if (l.startsWith('3010,')) acc.push([]); acc.at(-1)?.push(l); return acc; }, []);
  const found = records.find((r) => r.some((l) => l.toLowerCase() === `3030,"${surname.toLowerCase()}"`));
  if (!found) throw new Error(`no certificate for ${surname}`);
  return found;
}

describe('e@syFile certificate for 30 000 salary + 5 000 travel + a 14 000 vehicle + a 3 000 employer medical contribution', () => {
  it('3601 30 000, 3701 5 000, 3802 14 000, 3810 3 000, 4005 3 000, 4474 3 000, 4497 21 200 and 4582 15 200 (4 000 + 11 200)', async () => {
    const file = await exportFile();
    expect(file.status, file.body).toBe(200);
    const lines = recordOf(file.body, 'Fringe');
    expect(lines.filter((l) => /^(3601|3701|3802|3810|4005|4474|4497|4582),/.test(l))).toEqual([
      '3601,30000', '3701,5000', '3802,14000', '3810,3000', '4005,3000', '4474,3000', '4497,21200', '4582,15200',
    ]);
    expect(file.warnings.filter((w) => /4582/.test(w) && /Test Fringe/.test(w))).toEqual([]);
  });
});

describe('4582 counts only what the band sum counts', () => {
  it('the produced file: a non-taxable 3701 and a hand-assigned cash 3802 give 3601 32 000, 3701 1 000 and NO 4582', async () => {
    const file = await exportFile();
    expect(file.status, file.body).toBe(200);
    const zed = recordOf(file.body, 'Zed');
    expect(zed).toContain('3601,32000');
    expect(zed).toContain('3701,1000');
    expect(zed.some((l) => l.startsWith('4582,'))).toBe(false);
  });
  it('a non-taxable 3701 and a hand-assigned cash 3802 add nothing to the PAYE portion', async () => {
    const m = await listRunAllowanceFiling(company, { start: '2026-03-01', end: '2027-02-28' }, f2);
    expect(m.get(f2)).toEqual({ cash3701: 1000, taxableCash3701: 0, vehicle3802: 0, payeIncluded: 0, legacyLines: 0 });
  });
  it('the cash 3701 under R1 is not certified as 3701 and its cents stay in 3601', async () => {
    await pool.query("UPDATE payroll_run_lines SET component_breakdown = $2::jsonb WHERE run_id = $1 AND employee_id = $3", [runId, JSON.stringify([item('3601', 34_999.4), item('3701', 0.6, { payeInclusionRate: 0.8, payeIncludedAmount: 0.48 })]), f2]);
    await pool.query("UPDATE payroll_run_lines SET gross_pay = 35000 WHERE run_id = $1 AND employee_id = $2", [runId, f2]);
    const file = await exportFile();
    expect(file.status, file.body).toBe(200);
    const zed = recordOf(file.body, 'Zed');
    expect(zed).toContain('3601,35000');
    expect(zed.some((l) => l.startsWith('3701,') || l.startsWith('4582,'))).toBe(false);
  });
});
