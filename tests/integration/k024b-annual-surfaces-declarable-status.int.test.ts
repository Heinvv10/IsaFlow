/**
 * K-024 / R-005 review follow-up.
 *
 * The first two commits filtered the IRP5 e@syFile export, the EMP501 export
 * and the EMP501 reconciliation to EMP201_DECLARABLE_STATUSES. Two sibling
 * surfaces on the same table were left behind:
 *   - pages/api/payroll/irp5/summary.ts had NO status predicate at all, so the
 *     review screen disagreed with the file it previews.
 *   - pages/api/payroll/year-end/status.ts carried the same wrong triple
 *     ('approved','posted','calculated') the reconciliation had, giving a
 *     second EMP501 balance check that disagrees with the first.
 *
 * These tests pin every annual surface to the same run set, and pin the 400 on
 * a malformed taxYear that three of these routes were missing.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import irp5Summary from '../../pages/api/payroll/irp5/summary';
import easyfileExport from '../../pages/api/payroll/irp5/easyfile-export';
import yearEndStatus, { type YearEndStatus } from '../../pages/api/payroll/year-end/status';
import reconciliation, { type Emp501Summary } from '../../pages/api/payroll/emp501/reconciliation';
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
  await insertCompany(company, 'K024b payroll fixture');
  await insertCompany(otherCompany, 'K024b second tenant');
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await insertEmployee(employee, company, 'E-K024B', 'Grace', 'Hopper', '9001015800080', '1234567890');
  await insertEmployee(otherEmployee, otherCompany, 'E-K024B-X', 'Charles', 'Babbage', '9001015800082', '1234567892');
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

type Irp5SummaryPayload = {
  totalPayeSubmitted: number;
  employees: Array<{ lastName: string; totalGross: number; totalPaye: number }>;
};

async function call<T>(handler: (req: never, res: never) => Promise<void>, url: string, taxYear = '2026') {
  const result = textResponse();
  await handler(get(url, { taxYear }), result.res);
  return { status: result.state.statusCode, data: (result.state.body as { data: T })?.data, raw: result.state.body };
}

it('the IRP5 summary screen aggregates the same runs the e@syFile export writes', async () => {
  const summary = await call<Irp5SummaryPayload>(irp5Summary, '/api/payroll/irp5/summary');
  expect(summary.status).toBe(200);
  const hopper = summary.data.employees.find((e) => e.lastName === 'Hopper');
  // Approved R10 000 + paid R20 000. Not the calculated R500 000, the cancelled
  // R700 000, the prior-year R900 000 or the other tenant's R800 000.
  expect(hopper).toMatchObject({ totalGross: 30000, totalPaye: 3000 });
  expect(summary.data.totalPayeSubmitted).toBe(3000);
  expect(summary.data.employees.some((e) => e.lastName === 'Babbage')).toBe(false);

  // The screen previews this file, so the two must state the same gross.
  const result = textResponse();
  await easyfileExport(get('/api/payroll/irp5/easyfile-export', { taxYear: '2026' }), result.res);
  expect(String(result.state.body).split(/\r?\n/)).toContain(`3601,${hopper?.totalGross}`);
});

it('the year-end checklist reports the same runs and agrees with the EMP501 reconciliation', async () => {
  const status = await call<YearEndStatus>(yearEndStatus, '/api/payroll/year-end/status');
  expect(status.status).toBe(200);
  // Two declarable months (Mar approved, Jun paid), not the calculated or
  // cancelled ones and not the prior tax year.
  expect(status.data.payrollRuns).toMatchObject({ monthsCovered: 2, totalPaye: 3000 });
  expect(status.data.emp501).toMatchObject({
    balanced: true, totalEmp201: 3000, totalIrp5: 3000, totalVariance: 0,
  });
  expect(status.data.employees.withPayroll).toBe(1);

  // The second EMP501 balance check must not disagree with the first.
  const recon = await call<Emp501Summary>(reconciliation, '/api/payroll/emp501/reconciliation');
  expect(status.data.emp501.totalEmp201).toBe(recon.data.totalEmp201);
  expect(status.data.emp501.totalIrp5).toBe(recon.data.totalIrp5);
});

it('rejects a malformed taxYear with 400 rather than a Postgres 22P02', async () => {
  for (const [name, handler] of [
    ['easyfile-export', easyfileExport],
    ['reconciliation', reconciliation],
    ['year-end/status', yearEndStatus],
  ] as const) {
    const result = await call(handler as never, `/api/payroll/${name}`, 'abc');
    expect(result.status, name).toBe(400);
    const out = await call(handler as never, `/api/payroll/${name}`, '9999');
    expect(out.status, name).toBe(400);
  }
});
