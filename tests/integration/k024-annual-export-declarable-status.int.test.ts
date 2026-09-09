/**
 * K-024 RED: the IRP5 e@syFile export and the EMP501 CSV export aggregate
 * payroll_run_lines with NO status filter on payroll_run_headers, so a
 * `calculated` run (never approved, no GL journal) and a `cancelled` run
 * (withdrawn) are declared to SARS as remuneration.
 *
 * Canonical filter: EMP201_DECLARABLE_STATUSES = ['approved','paid']
 * (src/lib/constants/payrollRunStatuses.ts), already applied by emp201Service
 * and uifDeclarationService.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import easyfileExport from '../../pages/api/payroll/irp5/easyfile-export';
import emp501Export from '../../pages/api/payroll/emp501/export';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
const paidEmployee = crypto.randomUUID();
const otherEmployee = crypto.randomUUID();
const runs = {
  approved: crypto.randomUUID(),
  calculated: crypto.randomUUID(),
  cancelled: crypto.randomUUID(),
  paid: crypto.randomUUID(),
  priorYear: crypto.randomUUID(),
  otherCompany: crypto.randomUUID(),
};
let token = '';

/** Captures both res.json(body) and res.status(200).end(text). */
function textResponse() {
  const headers = new Map<string, unknown>();
  const state = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(n: string, v: unknown) { headers.set(n.toLowerCase(), v); return this; },
    getHeader(n: string) { return headers.get(n.toLowerCase()); },
    json(b: unknown) { this.body = b; return this; },
    send(b: unknown) { this.body = b; return this; },
    end(b?: unknown) { if (b !== undefined) this.body = b; return this; },
  };
  return { res: state as never, state };
}

async function insertRun(
  id: string, month: number, status: string, gross: number, paye: number,
  opts: { year?: number; companyId?: string; employeeId?: string } = {},
) {
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_paye)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, opts.companyId ?? company, month, opts.year ?? 2025, status, gross, paye],
  );
  await pool.query(
    `INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,uif_employee,uif_employer,sdl,net_pay)
     VALUES($1,$2,$3,$3,$4,0,0,0,$3)`,
    [id, opts.employeeId ?? employee, gross, paye],
  );
}

async function insertCompany(id: string, name: string) {
  await pool.query(
    `INSERT INTO companies(id,name,paye_reference_number,sars_contact_first_name,sars_contact_last_name,
       sars_contact_telephone,physical_address_line1,physical_postal_code,physical_city)
     VALUES($1,$2,'7123456789','Ada','Lovelace','0110000000','1 Fixture Street','0001','Pretoria')`,
    [id, name],
  );
}

async function insertEmployee(id: string, companyId: string, number: string, first: string, last: string, idNumber: string, taxNumber: string) {
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,id_number,tax_number,start_date)
     VALUES($1,$2,$3,$4,$5,$6,$7,'2020-01-01')`,
    [id, companyId, number, first, last, idNumber, taxNumber],
  );
}

beforeAll(async () => {
  await insertCompany(company, 'K024 payroll fixture');
  await insertCompany(otherCompany, 'K024 second tenant');
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await insertEmployee(employee, company, 'E-K024', 'Grace', 'Hopper', '9001015800080', '1234567890');
  await insertEmployee(paidEmployee, company, 'E-K024-P', 'Alan', 'Turing', '9001015800081', '1234567891');
  await insertEmployee(otherEmployee, otherCompany, 'E-K024-X', 'Charles', 'Babbage', '9001015800082', '1234567892');
  // Tax year 2026 = Mar 2025 .. Feb 2026.
  await insertRun(runs.approved, 3, 'approved', 10000, 1000);
  await insertRun(runs.calculated, 4, 'calculated', 500000, 200000);
  await insertRun(runs.cancelled, 5, 'cancelled', 700000, 300000);
  // 'paid' is declarable and must still be exported.
  await insertRun(runs.paid, 6, 'paid', 20000, 2000, { employeeId: paidEmployee });
  // Approved, but Feb 2025 belongs to tax year 2025 — outside the window.
  await insertRun(runs.priorYear, 2, 'approved', 900000, 400000);
  // Approved, but a different tenant.
  await insertRun(runs.otherCompany, 3, 'approved', 800000, 350000, {
    companyId: otherCompany, employeeId: otherEmployee,
  });
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id = ANY($1::uuid[])', [Object.values(runs)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

function get(url: string, query: Record<string, string>) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'GET') as never as {
    url: string; query: Record<string, string>;
  };
  req.url = url; req.query = query;
  return req as never;
}

it('IRP5 e@syFile export declares only approved/paid remuneration', async () => {
  const result = textResponse();
  await easyfileExport(get('/api/payroll/irp5/easyfile-export', { taxYear: '2026' }), result.res);
  expect(result.state.statusCode).toBe(200);
  const file = String(result.state.body);
  const lines = file.split(/\r?\n/);
  // Gross must be the declarable runs alone: 10 000 (approved) and 20 000 (paid).
  // Not 500 000 (calculated), 700 000 (cancelled), 900 000 (prior tax year) or
  // 800 000 (other tenant).
  expect(lines.filter((l) => l.startsWith('3601,'))).toEqual(['3601,10000', '3601,20000']);
  // 4102 is an N_CENTS field per the BRS, so cents are kept.
  expect(lines.filter((l) => l.startsWith('4102,'))).toEqual(['4102,1000.00', '4102,2000.00']);
  expect(file).not.toContain('Babbage');
});

it('EMP501 CSV export declares only approved/paid remuneration', async () => {
  const result = textResponse();
  await emp501Export(get('/api/payroll/emp501/export', { taxYear: '2026' }), result.res);
  expect(result.state.statusCode).toBe(200);
  const csv = String(result.state.body);
  const dataLines = csv.split('\n').slice(1);
  expect(dataLines).toEqual([
    'Grace Hopper,1234567890,10000.00,1000.00,0.00,0.00',
    'Alan Turing,1234567891,20000.00,2000.00,0.00,0.00',
  ]);
  // Calculated + cancelled + prior-year + other-tenant amounts are all excluded.
  for (const excluded of ['1210000.00', '500000.00', '700000.00', '900000.00', '800000.00', 'Babbage']) {
    expect(csv).not.toContain(excluded);
  }
});
