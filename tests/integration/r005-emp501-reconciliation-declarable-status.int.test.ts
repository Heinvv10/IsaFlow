/**
 * R-005 RED: the EMP501 reconciliation filters payroll runs with
 * `status IN ('approved','posted','calculated')`. 'posted' is not an admissible
 * status under the payroll_run_headers_status_check CHECK constraint (dead
 * value), and 'calculated' is explicitly non-declarable. The reconciliation
 * therefore uses a third status set, disagreeing with both the EMP201 report
 * and the IRP5/EMP501 exports it is meant to reconcile.
 *
 * Canonical filter: EMP201_DECLARABLE_STATUSES = ['approved','paid'].
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import reconciliation, { type Emp501Summary } from '../../pages/api/payroll/emp501/reconciliation';
import emp501Export from '../../pages/api/payroll/emp501/export';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const employee = crypto.randomUUID();
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
  await insertCompany(company, 'R005 payroll fixture');
  await insertCompany(otherCompany, 'R005 second tenant');
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await insertEmployee(employee, company, 'E-R005', 'Grace', 'Hopper', '9001015800080', '1234567890');
  await insertEmployee(otherEmployee, otherCompany, 'E-R005-X', 'Charles', 'Babbage', '9001015800082', '1234567892');
  // Tax year 2026 = Mar 2025 .. Feb 2026.
  await insertRun(runs.approved, 3, 'approved', 10000, 1000);
  await insertRun(runs.calculated, 4, 'calculated', 500000, 200000);
  await insertRun(runs.cancelled, 5, 'cancelled', 700000, 300000);
  await insertRun(runs.paid, 6, 'paid', 20000, 2000);
  // Approved, but Feb 2025 belongs to tax year 2025 — outside the window.
  await insertRun(runs.priorYear, 2, 'approved', 900000, 400000);
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

async function reconcile(): Promise<Emp501Summary> {
  const result = textResponse();
  await reconciliation(get('/api/payroll/emp501/reconciliation', { taxYear: '2026' }), result.res);
  expect(result.state.statusCode).toBe(200);
  return (result.state.body as { data: Emp501Summary }).data;
}

it('reconciles only approved/paid runs, month by month', async () => {
  const summary = await reconcile();
  const byLabel = new Map(summary.rows.map((r) => [r.monthLabel, r]));
  // Approved March and paid June are declarable.
  expect(byLabel.get('Mar 2025')).toMatchObject({ emp201Paye: 1000, irp5Paye: 1000, status: 'balanced' });
  expect(byLabel.get('Jun 2025')).toMatchObject({ emp201Paye: 2000, irp5Paye: 2000, status: 'balanced' });
  // Calculated April and cancelled May are not.
  expect(byLabel.get('Apr 2025')).toMatchObject({ emp201Paye: 0, irp5Paye: 0, status: 'no_data' });
  expect(byLabel.get('May 2025')).toMatchObject({ emp201Paye: 0, irp5Paye: 0, status: 'no_data' });
  // Feb 2026 is in the window but has no run; Feb 2025 is outside it entirely.
  expect(byLabel.get('Feb 2026')).toMatchObject({ emp201Paye: 0, status: 'no_data' });
  expect(summary.rows.some((r) => r.emp201Paye === 400000 || r.irp5Paye === 400000)).toBe(false);
  // The second tenant's approved R350 000 PAYE never appears.
  expect(summary.rows.some((r) => r.emp201Paye === 350000 || r.irp5Paye === 350000)).toBe(false);
});

it('agrees with the EMP501 export it reconciles', async () => {
  const summary = await reconcile();
  const result = textResponse();
  await emp501Export(get('/api/payroll/emp501/export', { taxYear: '2026' }), result.res);
  const exportedPaye = String(result.state.body)
    .split('\n').slice(1)
    .reduce((sum, line) => sum + Number(line.split(',')[3]), 0);
  expect(exportedPaye).toBe(3000);
  expect(summary.totalEmp201).toBe(exportedPaye);
  expect(summary.totalIrp5).toBe(exportedPaye);
  expect(summary.totalVariance).toBe(0);
});
