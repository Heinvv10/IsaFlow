/**
 * PAYE 4a follow-ups (G1, G2, G3): a SARS directive paid OUTSIDE payroll
 * (applyTaxDirective) is declared on the EMP201 of its payment month and on the
 * employee's certificate; a nil-tax directive gives an IT3(a); the directive
 * issued date (3231) is the directive's own issued date.
 *
 * Sources:
 * - SARS PAYE-GEN-01-G21 (2027) Rev 1, p. 15: lump sums paid by an employer on
 *   "Retrenchment, retirement or death ... reflect on IRP5/IT3(a) certificate
 *   under code 3901"; p. 22: "The full amount reflects under code 3901 and the
 *   tax under code 4115"; p. 21: the tax on a 3907 lump sum is reflected under
 *   4102. PAYE-AE-06-G06 (2026) Rev 13, p. 22: 3907 "Other lump sums".
 * - SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26): p. 17 (3015) an
 *   IRP5 needs 4101, 4102 or 4115 > 0 and no 4150; an IT3(a) needs 4150 and no
 *   4101/4102/4115. p. 58 (4150) value 04 is valid from 2024 "if directive
 *   information has been completed"; p. 108: 04 = "Non-taxable earnings,
 *   including nil directives". p. 41-44: the directive group 3230-3233 is
 *   mandatory for 3901 and 3907; 3230 is numeric only for 3901.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import directives from '../../pages/api/accounting/tax-directives';
import directive from '../../pages/api/accounting/tax-directives/[id]';
import type { Route } from './w3-01-payroll.helpers';
import { SignJWT } from 'jose';
import emp201Route from '../../pages/api/accounting/sars/sars-emp201';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';
import {
  applyStandalone, approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, seedRetrenchedEmployee,
  SALARY_PAYE, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let f: SeveranceFixture;
let nil: SeveranceFixture;
let standaloneId = '';
let runDirectiveId = '';

const SARS_PROFILE = `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
  sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
  physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`;

/** A directive made and approved through the real routes. */
async function routeDirective(fx: SeveranceFixture, body: Record<string, unknown>): Promise<string> {
  const made = await fx.call(directives as Route, 'POST', '/api/accounting/tax-directives', undefined, {
    body: { employee_id: fx.employee, employee_name: 'Wanda Test', ...body },
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  const ok = await fx.call(directive as Route, 'PATCH', `/api/accounting/tax-directives/${id}`, id, { body: { status: 'approved' } });
  expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  return id;
}

async function exportFile(fx: SeveranceFixture): Promise<{ status: number; file: string; warnings: string[]; body: unknown }> {
  const req = request({ 'sb-access-token': fx.token, active_company_id: fx.company }, 'GET') as unknown as {
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

/** The employee record of a one-employee file: from 3010 to its 9999 terminator. */
const employeeRecord = (file: string): string[] => {
  const lines = file.split(/\r\n/);
  const start = lines.findIndex(l => l.startsWith('3010,'));
  return lines.slice(start, lines.indexOf('9999,9999', start) + 1);
};

beforeAll(async () => {
  // Fixture 1: April salary, May severance paid by the run under a directive
  // (3901, R30 000 at 10%), and a stand-alone 3907 lump sum paid on 20 May
  // (R12 000 at 25%) whose directive carries no issued date.
  f = await seedRetrenchedEmployee(pool, '2026-04-30', 'P3fu filing');
  await pool.query(SARS_PROFILE, [f.company]);
  const april = await createRunFor(f, 4);
  await calculateRun(f, april);
  expect((await approveRun(f, april)).statusCode).toBe(200);
  runDirectiveId = await routeDirective(f, {
    directive_number: '9876543210', directive_type: 'severance', amount: 30_000, tax_rate: 0.1,
    effective_date: '2026-05-05', issued_date: '2026-05-02',
  });
  const may = await createRunFor(f, 5);
  await calculateRun(f, may);
  expect((await approveRun(f, may)).statusCode).toBe(200);
  standaloneId = await routeDirective(f, {
    directive_number: 'AB12345', directive_type: 'lump_sum', amount: 12_000, tax_rate: 0.25, effective_date: '2026-05-10',
  });
  const paid = await applyStandalone(f, standaloneId, '2026-05-20');
  expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);

  // Fixture 2: R5 000 a month (under the threshold: 60 000 × 18% = 10 800 <
  // the 17 820 rebate), leaving 31 March, severance under a NIL directive.
  nil = await seedRetrenchedEmployee(pool, '2026-03-31', 'P3fu nil directive', 5_000);
  await pool.query(SARS_PROFILE, [nil.company]);
  const march = await createRunFor(nil, 3);
  await calculateRun(nil, march);
  expect((await approveRun(nil, march)).statusCode).toBe(200);
  await routeDirective(nil, {
    directive_number: '5550001112', directive_type: 'severance', amount: 10_000, tax_rate: 0,
    effective_date: '2026-04-02', issued_date: '2026-04-01',
  });
  const aprilNil = await createRunFor(nil, 4);
  await calculateRun(nil, aprilNil);
  expect((await approveRun(nil, aprilNil)).statusCode).toBe(200);
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f, nil].filter(Boolean)); } finally { await pool.end(); }
});

describe('G1: directive PAYE paid outside payroll reaches EMP201, the IRP5 data and e@syFile', () => {
  it('EMP201 for May declares the run PAYE plus the stand-alone directive PAYE, with a breakdown line', async () => {
    const may = await generateEMP201(f.company, '2026-05-01', '2026-05-31');
    expect(may.totalPAYE).toBe(3_000 + 3_000);
    expect(may.payePayable).toBe(6_000);
    expect(may.directivePayments).toEqual([
      expect.objectContaining({ directiveNumber: 'AB12345', paymentDate: '2026-05-20', gross: 12_000, paye: 3_000 }),
    ]);
    const april = await generateEMP201(f.company, '2026-04-01', '2026-04-30');
    expect(april.totalPAYE).toBe(SALARY_PAYE);
    expect(april.directivePayments).toEqual([]);
  });

  it('the EMP201 route gives a viewer the totals but not the per-payment breakdown', async () => {
    const viewer = crypto.randomUUID();
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)", [viewer, `${viewer}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')", [f.company, viewer]);
    const token = await new SignJWT({ sub: viewer, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const get = async (tok: string) => {
      const req = request({ 'sb-access-token': tok, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
      req.url = '/api/accounting/sars/sars-emp201?from=2026-05-01&to=2026-05-31';
      req.query = { from: '2026-05-01', to: '2026-05-31' };
      const out = response();
      await (emp201Route as Route)(req as never, out.res as never);
      return out.state as { statusCode: number; body: { data?: { totalPAYE: number; directivePayments: unknown[] } } };
    };
    try {
      const asViewer = await get(token);
      const asAdmin = await get(f.token);
      expect(asViewer.statusCode, JSON.stringify(asViewer.body)).toBe(200);
      expect(asViewer.body.data!.totalPAYE).toBe(6_000);
      expect(asViewer.body.data!.directivePayments).toEqual([]);
      expect(asAdmin.body.data!.directivePayments).toHaveLength(1);
    } finally {
      await pool.query('DELETE FROM company_users WHERE user_id = $1', [viewer]);
      await pool.query('DELETE FROM users WHERE id = $1', [viewer]);
    }
  });

  it('EMP201 declares a period holding only the stand-alone payment', async () => {
    const onlyPayment = await generateEMP201(f.company, '2026-05-20', '2026-05-20');
    expect(onlyPayment.totalPAYE).toBe(3_000);
  });

  it('the IRP5 data carries both directives once each, and PAYE and gross include the stand-alone one', async () => {
    const row = (await getIrp5EmployeeTotals(f.company, 2027, { employeeId: f.employee })).rows[0]!;
    expect(row.paye).toBe(SALARY_PAYE + 3_000 + 3_000);
    expect(row.grossSalary).toBe(20_000 + 30_000 + 12_000);
    expect(row.lumpSums.map(l => [l.sourceCode, l.directiveNumber, l.directiveIssuedDate, l.amount, l.paye, l.payeCode])).toEqual([
      ['3901', '9876543210', '2026-05-02', 30_000, 3_000, '4115'],
      ['3907', 'AB12345', '2026-05-10', 12_000, 3_000, '4102'],
    ]);
  });

  it('e@syFile: 3901/4115 and 3907 under 4102, two directive groups, 3231 falls back with a warning naming the directive', async () => {
    const out = await exportFile(f);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const fields = employeeRecord(out.file);
    for (const want of ['3015,"IRP5"', '3601,20000', '3901,30000', '3907,12000', `4102,${(SALARY_PAYE + 3_000).toFixed(2)}`,
      '4115,3000.00', '3230,"9876543210"', '3231,20260502', '3232,3901', '3233,30000',
      '3230,"AB12345"', '3231,20260510', '3232,3907', '3233,12000']) {
      expect(fields, want).toContain(want);
    }
    expect(fields.filter(l => l.startsWith('3230,'))).toHaveLength(2);
    expect(fields.some(l => l.startsWith('4150,'))).toBe(false);
    expect(out.warnings).toEqual([expect.stringContaining('AB12345')]);
    expect(validateCertificateTaxFields(fields)).toEqual([]);
  });

  it('a run claim and a stand-alone payment are never one row (migration 901 CHECK), so the union cannot double-count', async () => {
    const claim = (await pool.query(
      'SELECT id, payroll_run_id FROM tax_directive_payments WHERE tax_directive_id = $1', [runDirectiveId])).rows[0]!;
    expect(claim.payroll_run_id).not.toBeNull();
    const journal = (await pool.query(
      'SELECT journal_entry_id FROM tax_directive_payments WHERE tax_directive_id = $1', [standaloneId])).rows[0]!.journal_entry_id;
    await expect(pool.query('UPDATE tax_directive_payments SET journal_entry_id = $2 WHERE id = $1', [claim.id, journal]))
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('G1: a directive linked to no employee is refused at apply', () => {
  it('400, naming why, and nothing is written', async () => {
    const made = await f.call(directives as Route, 'POST', '/api/accounting/tax-directives', undefined, {
      body: { employee_name: 'Nobody Linked', directive_number: '1112223334', directive_type: 'death', amount: 5_000, tax_rate: 0.1, effective_date: '2026-06-01' },
    });
    const id = String(made.body.data!.id);
    expect((await f.call(directive as Route, 'PATCH', `/api/accounting/tax-directives/${id}`, id, { body: { status: 'approved' } })).statusCode).toBe(200);
    const r = await applyStandalone(f, id, '2026-06-05');
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/not linked to an employee/);
    expect((await pool.query('SELECT 1 FROM tax_directive_payments WHERE tax_directive_id = $1', [id])).rowCount).toBe(0);
  });
});

describe('G2: a certificate with nil tax is an IT3(a) with reason 04', () => {
  it('the nil directive paid in the run gives an IT3(a): 4150 = 04, no 4102 or 4115, and it validates', async () => {
    const out = await exportFile(nil);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const fields = employeeRecord(out.file);
    expect(fields).toContain('3015,"IT3(a)"');
    expect(fields).toContain('4150,04');
    expect(fields).toContain('3901,10000');
    expect(fields.filter(l => /^(4101|4102|4115),/.test(l))).toEqual([]);
    expect(fields).toContain('3230,"5550001112"');
    expect(validateCertificateTaxFields(fields)).toEqual([]);
  });

  it('the validator refuses that record as an IRP5', () => {
    const asIrp5 = ['3015,"IRP5"', '3901,10000', '4102,0.00', '4115,0.00', '3230,"5550001112"', '3231,20260401', '3232,3901', '3233,10000'];
    expect(validateCertificateTaxFields(asIrp5).map(m => m.code)).toContain('IRP5_NO_TAX');
  });
});

describe('G3: the directive issued date', () => {
  it('POST stores issued_date, PATCH changes it, and a malformed one is refused', async () => {
    const row = (await pool.query('SELECT issued_date::text AS d FROM tax_directives WHERE id = $1', [runDirectiveId])).rows[0]!;
    expect(row.d).toBe('2026-05-02');
    const ok = await f.call(directive as Route, 'PATCH', `/api/accounting/tax-directives/${standaloneId}`, standaloneId, { body: { issued_date: '2026-05-09' } });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data!.issuedDate).toBe('2026-05-09');
    const bad = await f.call(directive as Route, 'PATCH', `/api/accounting/tax-directives/${standaloneId}`, standaloneId, { body: { issued_date: '9 May' } });
    expect(bad.statusCode).toBe(400);
    const out = await exportFile(f);
    expect(employeeRecord(out.file)).toContain('3231,20260509');
    expect(out.warnings).toEqual([]);
  });
});
