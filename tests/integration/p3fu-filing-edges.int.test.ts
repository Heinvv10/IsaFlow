/**
 * PAYE 4a follow-ups G1/G3, edges (from review): an employee paid ONLY by a
 * stand-alone directive gets a certificate row of their own; a reversed
 * stand-alone payment is on no certificate; a legacy payment under a directive
 * linked to no employee is warned about; the e@syFile warning header is capped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import type { Route } from './w3-01-payroll.helpers';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import {
  applyStandalone, approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, directivePayments,
  seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

const SARS_PROFILE = `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
  sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
  physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`;

async function exportFile(fx: SeveranceFixture) {
  const req = request({ 'sb-access-token': fx.token, active_company_id: fx.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
  req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
  req.query = { taxYear: '2027' };
  const out = response();
  let file = '';
  out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
  await (easyfile as Route)(req as never, out.res as never);
  const raw = out.headers.get('x-isaflow-warnings');
  return { status: out.state.statusCode, file, body: out.state.body, warnings: raw ? JSON.parse(decodeURIComponent(String(raw))) as string[] : [] };
}

/** An employee who left in February 2026 (no run in tax year 2027) and is paid lump sums outside payroll. */
async function leaverPaidOutsidePayroll(name: string): Promise<SeveranceFixture> {
  const f = await seedRetrenchedEmployee(pool, '2026-02-28', name);
  fixtures.push(f);
  await pool.query(SARS_PROFILE, [f.company]);
  return f;
}

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('G1 edges', () => {
  it('an employee paid only outside payroll this year has a certificate row (and counts in the universe)', async () => {
    const f = await leaverPaidOutsidePayroll('P3fu only stand-alone');
    const d = await approvedDirective(f, 40_000, 0.2, '2026-04-01', '4440001112');
    expect((await applyStandalone(f, d, '2026-04-10')).statusCode).toBe(200);
    // A run still only calculated (not declarable) also carries them: they are a certificate row, not an exclusion.
    const draft = (await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status) VALUES ($1, 2026, 5, 'calculated') RETURNING id`,
      [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, net_pay) VALUES ($1, $2, 1000, 1000, 0, 1000)`,
      [draft, f.employee]);
    const data = await getIrp5EmployeeTotals(f.company, 2027, { employeeId: f.employee });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ grossSalary: 40_000, paye: 8_000, runsIncluded: 0, netPay: 32_000 });
    expect(data.universeTotal).toBe(1);
    expect(data.excludedTotal).toBe(0);
    const out = await exportFile(f);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.file.split(/\r\n/)).toEqual(expect.arrayContaining(['3901,40000', '4115,8000.00', '3230,"4440001112"']));
  });

  it('a reversed stand-alone payment is on no certificate', async () => {
    const f = await leaverPaidOutsidePayroll('P3fu reversed stand-alone');
    const d = await approvedDirective(f, 40_000, 0.2, '2026-04-01', '4440001113');
    expect((await applyStandalone(f, d, '2026-04-10')).statusCode).toBe(200);
    const journal = String((await directivePayments(pool, d))[0]!.journal_entry_id);
    const rev = await f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } });
    expect(rev.statusCode).toBe(200);
    expect((await getIrp5EmployeeTotals(f.company, 2027, { employeeId: f.employee })).rows).toEqual([]);
  });

  it('a payment whose reversal is only a draft still stands: it is not released', async () => {
    const f = await leaverPaidOutsidePayroll('P3fu draft reversal');
    const d = await approvedDirective(f, 40_000, 0.2, '2026-04-01', '4440001114');
    expect((await applyStandalone(f, d, '2026-04-10')).statusCode).toBe(200);
    const journal = String((await directivePayments(pool, d))[0]!.journal_entry_id);
    // A reversal drafted but not posted: the chain is 'unclear', not 'out'.
    await pool.query('UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = $1', [journal]);
    await pool.query(
      `INSERT INTO gl_journal_entries (company_id, entry_date, description, status, source, reversal_of_id, created_by)
       VALUES ($1, '2026-04-11', 'Draft reversal', 'draft', 'auto_payroll', $2, $3)`, [f.company, journal, f.admin]);
    const { releaseReversedStandalonePayment } = await import('@/modules/accounting/services/payroll/taxDirectivePaidGuard');
    await releaseReversedStandalonePayment(f.company, null);
    expect(await directivePayments(pool, d)).toHaveLength(1);
  });

  it('a payment under a directive linked to no employee is warned about by name, first, and the warnings are capped by size', async () => {
    const f = await leaverPaidOutsidePayroll('P3fu warnings');
    // Twelve stand-alone payments under directives with no issued date: twelve 3231 fallbacks.
    for (let i = 0; i < 12; i += 1) {
      const d = await approvedDirective(f, 1_000, 0.1, '2026-04-01', `55500011${String(i).padStart(2, '0')}`);
      expect((await applyStandalone(f, d, '2026-04-10')).statusCode).toBe(200);
    }
    // A legacy payment (before apply refused it) under a directive linked to nobody.
    const orphan = (await pool.query(
      `INSERT INTO tax_directives (company_id, employee_name, directive_number, directive_type, amount, tax_rate, effective_date, status)
       VALUES ($1, 'Nobody Linked', '9990001112', 'death', 2000, 0.1, '2026-04-01', 'approved') RETURNING id`, [f.company])).rows[0]!.id;
    const je = String((await directivePayments(pool, (await pool.query(
      'SELECT tax_directive_id FROM tax_directive_payments WHERE company_id = $1 LIMIT 1', [f.company])).rows[0]!.tax_directive_id))[0]!.journal_entry_id);
    await pool.query(
      `INSERT INTO tax_directive_payments (company_id, tax_directive_id, payment_date, gross_amount, paye_amount, net_amount, journal_entry_id)
       VALUES ($1, $2, '2026-04-10', 2000, 200, 1800, $3)`, [f.company, orphan, je]);
    const out = await exportFile(f);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    // Capped by encoded size: the header stays within 2 000 bytes, and the rest is counted.
    const raw = encodeURIComponent(JSON.stringify(out.warnings));
    expect(raw.length).toBeLessThanOrEqual(2_000);
    expect(out.warnings.length).toBeLessThan(13);
    // The payment on no certificate comes first, so the cap never hides it.
    expect(out.warnings[0]).toMatch(/9990001112.*linked to no employee/);
    expect(out.warnings.at(-1)).toMatch(new RegExp(`and ${13 - (out.warnings.length - 1)} more`));
  });
});

describe('G2 edges: reason 02 only under the tax threshold, through the export route', () => {
  /** One approved March run (tax year 2027) for an employee born 1980 (threshold R99 000) leaving 31 March. */
  async function marchOnly(name: string, monthly: number): Promise<SeveranceFixture> {
    const f = await seedRetrenchedEmployee(pool, '2026-03-31', name, monthly);
    fixtures.push(f);
    await pool.query(SARS_PROFILE, [f.company]);
    const march = await createRunFor(f, 3);
    await calculateRun(f, march);
    expect((await approveRun(f, march)).statusCode).toBe(200);
    return f;
  }

  it('R5 000 with nil PAYE: an IT3(a) with reason 02', async () => {
    const f = await marchOnly('P3fu under threshold', 5_000);
    const out = await exportFile(f);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.file.split(/\r\n/)).toEqual(expect.arrayContaining(['3015,"IT3(a)"', '4150,02', '3601,5000']));
  });

  it('R120 000 with nil PAYE (above R99 000): refused, naming the employee and the threshold', async () => {
    const f = await marchOnly('P3fu nil above threshold', 120_000);
    await pool.query('UPDATE payroll_run_lines SET paye = 0 WHERE employee_id = $1', [f.employee]);
    const out = await exportFile(f);
    expect(out.status).not.toBe(200);
    expect(JSON.stringify(out.body)).toMatch(/Test.*above the tax threshold of R99000\.00/);
  });

  it('no date of birth: the age comes from the ID number (800101…, born 1980)', async () => {
    const f = await marchOnly('P3fu date of birth from ID', 5_000);
    await pool.query('UPDATE payroll_employees SET date_of_birth = NULL WHERE id = $1', [f.employee]);
    const out = await exportFile(f);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.file.split(/\r\n/)).toEqual(expect.arrayContaining(['3015,"IT3(a)"', '4150,02']));
  });

  // An ID number with no date in it is refused before the threshold is judged: 3080 is mandatory and must correlate with it.
  it('neither a date of birth nor a readable ID number: refused, asking for the ID number', async () => {
    const f = await marchOnly('P3fu no date of birth', 5_000);
    await pool.query("UPDATE payroll_employees SET date_of_birth = NULL, id_number = '8013015009087' WHERE id = $1", [f.employee]);
    const out = await exportFile(f);
    expect(out.status).not.toBe(200);
    expect(JSON.stringify(out.body)).toMatch(/ID number \(8013015009087\) does not begin with a valid date of birth.*3080/);
  });
});
