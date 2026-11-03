/**
 * A non-cash 3801 benefit on the year-end filings (Hein 2026-11-03: under its own SARS code, not in
 * 3601). Code 3801 per SARS PAYE-AE-06-G06 (2026 Rev 13 / 2027 Rev 14, p. 16: "low interest or
 * interest free loans and subsidies"). History through the real routes: January to November 2026
 * calculated and approved, R41 000 cash + R1 000 benefit a month. Tax year 2027 (March 2026 to
 * February 2027) holds March to November: 9 months, R369 000 cash, R9 000 benefit.
 *
 * Each filing must carry the benefit once, under 3801, beside the cash, so
 * cash income + 3801 = the remuneration taxed (taxable_income, no deductions here), and PAYE
 * (4102) is the lines' PAYE, the benefit's tax included. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import easyfileExport from '../../pages/api/payroll/irp5/easyfile-export';
import emp501Export from '../../pages/api/payroll/emp501/export';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import { approve, approvedMonths, benefitFromJanuary } from './payrun-noncash-benefit.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, recalculate } = fx;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(async () => { vi.restoreAllMocks(); await fx.dropCompany(); });
afterAll(fx.tearDown);

/** GET a text export as the company's admin; the body is whatever the route sent or ended with. */
async function exportText(route: (req: never, res: never) => Promise<unknown>, url: string): Promise<{ status: number; body: string }> {
  const token = await new SignJWT({ sub: fx.admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: state.coA }, 'GET') as never as { url: string; query: Record<string, string> };
  req.url = url;
  req.query = { taxYear: '2027' };
  const out = { status: 200, body: '' };
  const res = {
    status(code: number) { out.status = code; return res; },
    setHeader() { return res; },
    getHeader() { return undefined; },
    json(b: unknown) { out.body = JSON.stringify(b); return res; },
    send(b: unknown) { out.body = String(b); return res; },
    end(b?: unknown) { if (b !== undefined) out.body = String(b); return res; },
  };
  await route(req as never, res as never);
  return out;
}

/** Tax year 2027's approved lines for the employee: cash gross, taxable income and PAYE. */
async function declared(): Promise<{ gross: number; taxable: number; paye: number }> {
  return (await pool.query(
    `SELECT SUM(l.gross_pay)::float8 AS gross, SUM(l.taxable_income)::float8 AS taxable, SUM(l.paye)::float8 AS paye
       FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
      WHERE h.company_id = $1 AND h.status = 'approved' AND make_date(h.period_year, h.period_month, 1) >= DATE '2026-03-01'`,
    [state.coA])).rows[0]!;
}

describe('a non-cash 3801 benefit on the IRP5 data, e@syFile and EMP501', () => {
  it('is certified under 3801, outside 3601, and cash + 3801 reconciles to the remuneration taxed', async () => {
    await pool.query(
      `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Ada', sars_contact_last_name = 'Lovelace',
         sars_contact_telephone = '0110000000', physical_address_line1 = '1 Fixture Street', physical_postal_code = '0001', physical_city = 'Pretoria'
       WHERE id = $1`, [state.coA]);
    // A valid SA ID number for the fixture's 1980-01-01 date of birth (3060 / 3080).
    await pool.query(`UPDATE payroll_employees SET id_number = '8001015009087' WHERE id = $1`, [state.employee]);
    await benefitFromJanuary(pool, fx);
    await approvedMonths(pool, fx, 10);
    await recalculate(state.nov);
    await approve(fx, state.nov, 'November');

    const d = await declared();
    expect(d).toMatchObject({ gross: 369_000, taxable: 378_000 });
    expect(d.paye).toBeGreaterThan(0);

    // IRP5 data: cash gross, the benefit beside it, and the two add up to the remuneration taxed.
    const [row] = (await getIrp5EmployeeTotals(state.coA, 2027)).rows;
    expect(row).toMatchObject({ grossSalary: 369_000, taxableIncome: 378_000, fringeBenefits: [{ sourceCode: '3801', amount: 9_000 }] });
    expect(row!.paye).toBeCloseTo(d.paye, 2);
    expect(row!.grossSalary + row!.fringeBenefits.reduce((s, b) => s + b.amount, 0)).toBe(row!.taxableIncome);

    // e@syFile: 3601 cash only, 3801 the benefit, in code order before 4102; PAYE unchanged.
    const easy = await exportText(easyfileExport as never, '/api/payroll/irp5/easyfile-export');
    expect(easy.status, easy.body).toBe(200);
    const lines = easy.body.split(/\r?\n/);
    expect(lines.filter((l) => /^3[6-9]\d\d,/.test(l))).toEqual(['3601,369000', '3801,9000']);
    expect(lines.filter((l) => l.startsWith('4102,'))).toEqual([`4102,${d.paye.toFixed(2)}`]);
    expect(lines.indexOf('3801,9000')).toBeLessThan(lines.findIndex((l) => l.startsWith('4102,')));

    // EMP501: gross_income stays cash; fringe_3801 carries the benefit; together the remuneration.
    const emp501 = await exportText(emp501Export as never, '/api/payroll/emp501/export');
    expect(emp501.status, emp501.body).toBe(200);
    const [head, data] = emp501.body.split('\n');
    expect(head).toBe('employee_name,irp5_number,gross_income,paye,uif,sdl,fringe_3801');
    const cols = data!.split(',');
    expect(cols[2]).toBe('369000.00');
    expect(cols[3]).toBe(d.paye.toFixed(2));
    expect(cols[6]).toBe('9000.00');
    expect(Number(cols[2]) + Number(cols[6])).toBe(d.taxable);
  });
});
