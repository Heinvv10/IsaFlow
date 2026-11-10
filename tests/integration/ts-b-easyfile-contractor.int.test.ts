/**
 * The e@syFile export for an independent contractor (TS-b; PAYE-GEN-01-G21 (2027) p. 26, BRS V25.3.0 p. 62 and 109): income under 3616,
 * decided per line (the line's PAYE_OUTSIDE_TABLES with treatment none), a no-tax certificate is an IT3(a) with 4150 = 03, and a
 * contractor's annual payment stays 3605. Disposable fixture DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import easyfileExport from '../../pages/api/payroll/irp5/easyfile-export';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const company = crypto.randomUUID();
// Separate companies for a file that is REFUSED and for the directive and non-cash cases, so one does not fail the others.
const refusing = crypto.randomUUID();
const directiveCo = crypto.randomUUID();
const reversalCo = crypto.randomUUID();
const everyCompany = [company, refusing, directiveCo, reversalCo];
const user = crypto.randomUUID();

const item = (code: string, amount: number) => ({ componentId: code, componentName: code, sarsSourceCode: code, amount, isTaxable: true, isUifApplicable: false });
const CONTRACTOR = [{ code: 'PAYE_OUTSIDE_TABLES', severity: 'warning', treatment: 'none', message: 'contractor' }];

async function employee(last: string, of = company): Promise<string> {
  return (await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
     VALUES ($1, $2, 'Test', $2, '2020-01-01', '1980-01-01', '8001015009087', '0123456789') RETURNING id`, [of, last])).rows[0]!.id;
}

/** One approved run per month; a line of `gross` with `items`, flagged as a contractor's or not. */
const runs = new Map<string, string>();
async function line(month: number, employeeId: string, gross: number, paye: number, items: unknown[], contractor: boolean, of = company): Promise<void> {
  let run = runs.get(`${of}:${month}`);
  if (!run) {
    run = (await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross) VALUES ($1, $2, 2026, 'approved', 0) RETURNING id`,
      [of, month])).rows[0]!.id as string;
    runs.set(`${of}:${month}`, run);
  }
  await pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown, validation_results)
     VALUES ($1, $2, $3, $3, $4, 0, 0, 0, $5::jsonb, $6::jsonb)`,
    [run, employeeId, gross, paye, JSON.stringify(items), JSON.stringify(contractor ? CONTRACTOR : [])]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [user, `${user}@test.local`]);
  for (const id of everyCompany) {
    await pool.query(
      `INSERT INTO companies (id, name, paye_reference_number, sars_contact_first_name, sars_contact_last_name, sars_contact_telephone,
         physical_address_line1, physical_postal_code, physical_city)
       VALUES ($1, 'e@syFile contractor', '7123456789', 'Ada', 'Lovelace', '0110000000', '1 Fixture Street', '0001', 'Pretoria')`, [id]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [id, user]);
  }
  // Switched to contractor: March as an employee, April as a contractor, no PAYE.
  const toContractor = await employee('Tocontractor');
  await line(3, toContractor, 10_000, 0, [item('3601', 10_000)], false);
  await line(4, toContractor, 12_000, 0, [item('3601', 12_000)], true);
  // Switched back to employee: March as a contractor, April as an employee with PAYE.
  const backToEmployee = await employee('Backtoemployee');
  await line(3, backToEmployee, 20_000, 0, [item('3601', 20_000)], true);
  await line(4, backToEmployee, 30_000, 1_000, [item('3601', 30_000)], false);
  // Over the threshold as a contractor, no PAYE.
  const rich = await employee('Richcontractor');
  await line(3, rich, 150_000, 0, [item('3601', 150_000)], true);
  // A contractor paid only an annual payment.
  const bonusOnly = await employee('Bonusonly');
  await line(3, bonusOnly, 150_000, 0, [item('3605', 150_000)], true);
  // A directive paid in March and reversed in April on contractor lines: net nil, so 3616 is the 100 000 of fees and nothing is 3601.
  const reversedId = crypto.randomUUID();
  const reversed = await employee('Reversed', reversalCo);
  await pool.query(
    `INSERT INTO tax_directives (id, company_id, employee_id, employee_name, directive_number, directive_type, amount, tax_rate, effective_date, status)
     VALUES ($1, $2, $3, 'Test Reversed', '1234567891', 'severance', 50000, 0, '2026-03-01', 'approved')`, [reversedId, reversalCo, reversed]);
  const dir = (amount: number) => ({ ...item('3901', amount), directive: { id: reversedId, number: '1234567891', paye: 0 } });
  await line(3, reversed, 150_000, 0, [item('3601', 100_000), dir(50_000)], true, reversalCo);
  await line(4, reversed, -50_000, 0, [dir(-50_000)], true, reversalCo);
  // (a) A cross-year reversal on a pure contractor: this export year sees 100 000 of fees and the -50 000 reversal of a payment made last year.
  const crossYear = await employee('Crossyear', reversalCo);
  await line(3, crossYear, 50_000, 0, [item('3601', 100_000), dir(-50_000)], true, reversalCo);
  // (b) Paid on an employee line (with PAYE), reversed on a contractor line beside 100 000 of fees: 3601 100 000, 3616 100 000.
  const paidThenReversed = await employee('Paidthenreversed', reversalCo);
  await line(3, paidThenReversed, 150_000, 1_000, [item('3601', 100_000), dir(50_000)], false, reversalCo);
  await line(4, paidThenReversed, 50_000, 0, [item('3601', 100_000), dir(-50_000)], true, reversalCo);
  // An ORPHAN directive item (no tax_directives row): the lump-sum list does not file it, so it must not leave 3616 either.
  const orphan = await employee('Orphan', reversalCo);
  await line(3, orphan, 120_000, 0, [
    item('3601', 100_000), { ...item('3901', 20_000), directive: { id: crypto.randomUUID(), number: '9999999999', paye: 0 } },
  ], true, reversalCo);
  // A contractor bonus of 30 000 in March and a 10 000 clawback in April: each line is floored at nil, so 30 000 is 3616's, not 20 000.
  const clawback = await employee('Clawback');
  await line(3, clawback, 40_000, 0, [item('3601', 10_000), item('3605', 30_000)], true);
  await line(4, clawback, 5_000, 0, [item('3601', 15_000), item('3605', -10_000)], true);
  // Refused: 120 000 of employee pay with nil PAYE beside 1 000 of contractor fees (the employee part is over the threshold).
  const mixed = await employee('Mixedrefused', refusing);
  await line(3, mixed, 120_000, 0, [item('3601', 120_000)], false, refusing);
  await line(4, mixed, 1_000, 0, [item('3601', 1_000)], true, refusing);
  // A contractor paid 100 000 of fees and a 50 000 severance directive in the same line, and a 7 000 non-cash benefit.
  const directiveId = crypto.randomUUID();
  const withDirective = await employee('Withdirective', directiveCo);
  await pool.query(
    `INSERT INTO tax_directives (id, company_id, employee_id, employee_name, directive_number, directive_type, amount, tax_rate, effective_date, status)
     VALUES ($1, $2, $3, 'Test Withdirective', '1234567890', 'severance', 50000, 0, '2026-03-01', 'approved')`, [directiveId, directiveCo, withDirective]);
  await line(3, withDirective, 150_000, 0, [
    item('3601', 100_000),
    { ...item('3901', 50_000), directive: { id: directiveId, number: '1234567890', paye: 0 } },
    { ...item('3801', 7_000), isNonCash: true },
  ], true, directiveCo);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ANY($1))', [everyCompany]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)', [everyCompany]);
    await pool.query('DELETE FROM tax_directives WHERE company_id = ANY($1)', [everyCompany]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [everyCompany]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [everyCompany]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [everyCompany]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally {
    await pool.end();
  }
});

async function exportFile(of = company): Promise<{ status: number; body: string }> {
  const token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: of }, 'GET') as never as { url: string; query: Record<string, string> };
  req.url = '/api/payroll/irp5/easyfile-export';
  req.query = { taxYear: '2027' };
  const out = { status: 200, body: '' };
  const res = {
    status(code: number) { out.status = code; return res; },
    setHeader() { return res; }, getHeader() { return undefined; },
    json(b: unknown) { out.body = JSON.stringify(b); return res; },
    send(b: unknown) { out.body = String(b); return res; },
    end(b?: unknown) { if (b !== undefined) out.body = String(b); return res; },
  };
  await easyfileExport(req as never, res as never);
  return out;
}

/** The certificate record whose 3030 is `surname`, as its lines. */
function recordOf(body: string, surname: string): string[] {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex(l => l === `3030,"${surname}"` || l.startsWith(`3030,"${surname}`));
  expect(at, `${surname} has a certificate`).toBeGreaterThan(0);
  const start = lines.slice(0, at).map(l => l.startsWith('3010,')).lastIndexOf(true);
  const end = lines.findIndex((l, i) => i > at && l.startsWith('9999,'));
  return lines.slice(start, end + 1);
}

describe('e@syFile: a contractor is 3616, decided per line', () => {
  it('the file is written (no refusal for the contractors over the threshold)', async () => {
    const file = await exportFile();
    expect(file.status, file.body.slice(0, 300)).toBe(200);
  });

  it('employee then contractor: March is 3601, April is 3616, IT3(a) with 4150 = 03', async () => {
    const r = recordOf((await exportFile()).body, 'Tocontractor');
    expect(r).toEqual(expect.arrayContaining(['3601,10000', '3616,12000', '4150,03', '3015,"IT3(a)"']));
  });

  it('contractor then employee, PAYE withheld: an IRP5 with 3616 for March, 3601 for April, no 4150', async () => {
    const r = recordOf((await exportFile()).body, 'Backtoemployee');
    expect(r).toEqual(expect.arrayContaining(['3601,30000', '3616,20000', '3015,"IRP5"']));
    expect(r.some(l => l.startsWith('4150,'))).toBe(false);
  });

  it('R150 000 as a contractor with no PAYE: 3616 and reason 03, never 3601 and never refused', async () => {
    const r = recordOf((await exportFile()).body, 'Richcontractor');
    expect(r).toEqual(expect.arrayContaining(['3616,150000', '4150,03']));
    expect(r.some(l => l.startsWith('3601,'))).toBe(false);
  });

  it('a contractor paid only what the payroll calls an annual payment: all of it is 3616, reason 03, the file accepted', async () => {
    const file = await exportFile();
    expect(file.status).toBe(200);
    const r = recordOf(file.body, 'Bonusonly');
    expect(r).toEqual(expect.arrayContaining(['3616,150000', '4150,03']));
    expect(r.some(l => l.startsWith('3605,') || l.startsWith('3601,'))).toBe(false);
  });

  it('contractor fees 100 000 plus a 50 000 directive: 3616 100 000, the directive as 3901 lump sum, 3801 benefit as 3616 (107 000 in all), no 3601, no 3801', async () => {
    const file = await exportFile(directiveCo);
    expect(file.status, file.body.slice(0, 300)).toBe(200);
    const r = recordOf(file.body, 'Withdirective');
    expect(r).toEqual(expect.arrayContaining(['3616,107000', '3901,50000']));
    expect(r.some(l => l.startsWith('3601,') || l.startsWith('3801,'))).toBe(false);
  });

  it('120 000 of employee pay with nil PAYE beside 1 000 of contractor fees refuses the file (03 does not hide the employee part)', async () => {
    const file = await exportFile(refusing);
    expect(file.status).toBe(422);
    expect(file.body).toMatch(/Mixedrefused/);
    expect(file.body).toMatch(/no PAYE was deducted/);
  });

  it('a contractor annual payment and its clawback in separate lines: each is floored at nil, so no 3605 is left over for the employee', async () => {
    const r = recordOf((await exportFile()).body, 'Clawback');
    expect(r).toEqual(expect.arrayContaining(['3616,45000', '4150,03']));
    expect(r.some(l => l.startsWith('3605,') || l.startsWith('3601,'))).toBe(false);
  });

  it('a directive reversed on a contractor line nets as the lump-sum list nets it (no per-line floor): 3616 is the 100 000, no 3601', async () => {
    const file = await exportFile(reversalCo);
    expect(file.status, file.body.slice(0, 300)).toBe(200);
    const r = recordOf(file.body, 'Reversed');
    expect(r).toContain('3616,100000');
    expect(r.some(l => l.startsWith('3601,'))).toBe(false);
  });

  it('an orphan directive item (no directive row) stays in 3616: it is filed as no lump sum, so it is not removed from the contractor income', async () => {
    const r = recordOf((await exportFile(reversalCo)).body, 'Orphan');
    expect(r).toContain('3616,120000');
    expect(r.some(l => l.startsWith('3901,') || l.startsWith('3601,'))).toBe(false);
  });

  it('(a) a cross-year reversal on a pure contractor: the directive nets below nil as the lump-sum list nets it, so 3601 is nil and 3616 is the 100 000', async () => {
    const r = recordOf((await exportFile(reversalCo)).body, 'Crossyear');
    expect(r).toContain('3616,100000');
    expect(r.some(l => l.startsWith('3601,'))).toBe(false);
  });

  it('(b) paid on an employee line and reversed on a contractor line beside 100 000 of fees: 3601 100 000, 3616 100 000', async () => {
    const r = recordOf((await exportFile(reversalCo)).body, 'Paidthenreversed');
    expect(r).toEqual(expect.arrayContaining(['3601,100000', '3616,100000']));
  });
});
