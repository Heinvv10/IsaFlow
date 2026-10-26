/**
 * PAYE 4c: a retirement fund contribution the employee pays the fund directly
 * (payroll_components.paid_outside_payroll, migration 948): it counts for the
 * s11F deduction and the certificate's 4001/4003/4006 but stays out of net
 * pay, total deductions and the 2175 journal line. Only a deduction coded
 * 4001/4003/4006 may carry it: the route refuses the rest with a 400, and the
 * CHECK refuses any other writer.
 *
 * Employee A is a real employer's payroll (numbers only): R60 000, a private
 * retirement annuity of R2 708.59 a month. ASSUMPTION, not on file: four
 * medical aid beneficiaries, back-solved from the employer's Sage PAYE
 * (12 440.51 × 12 = 149 286.12 against 164 405.89 before credits: 15 119.77 a
 * year ≈ 1 260 a month = 2 × 376 + 2 × 254, four people). Sage's nett pay is
 * 60 000 − 12 440.51 − 177.12 = 47 382.37; IsaFlow's PAYE is 12 440.49 (the
 * 2c is Sage's annualisation, see the PR), so its net pay is 47 382.39.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import componentsRoute from '../../pages/api/payroll/components';
import assignRoute from '../../pages/api/payroll/employees/[id]/components';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import createRun from '../../pages/api/payroll/runs';
import { approveRun, calculateRun, cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
let f: SeveranceFixture;

async function createComponent(body: Record<string, unknown>) {
  return f.call(componentsRoute as Route, 'POST', '/api/payroll/components', undefined, { body });
}
const componentNames = async () => (await pool.query<{ name: string }>(
  'SELECT name FROM payroll_components WHERE company_id = $1 ORDER BY name', [f.company])).rows.map(r => r.name);

beforeAll(async () => {
  f = await seedEmployee(pool, fixtures, 'P4c private RA', 60_000);
  // Medical aid: the labelled assumption above (main member + 3 dependants).
  await pool.query('UPDATE payroll_employees SET medical_aid_main_member = true, medical_aid_dependants_count = 3 WHERE id = $1', [f.employee]);
  await pool.query(`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
    sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
    physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`, [f.company]);
});
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('POST /api/payroll/components: paidOutsidePayroll', () => {
  it('only a deduction coded 4001/4003/4006 takes it; the rest are 400 and nothing is written', async () => {
    const before = await componentNames();
    for (const [name, componentType, code] of [
      ['PO earning', 'earning', '4006'], ['PO medical', 'deduction', '4005'], ['PO donation', 'deduction', '4030'],
    ] as const) {
      const out = await createComponent({ name, sarsSourceCode: code, componentType, paidOutsidePayroll: true });
      expect(out.statusCode, `${name}: ${JSON.stringify(out.body)}`).toBe(400);
      expect(JSON.stringify(out.body)).toMatch(/only a retirement fund contribution/i);
    }
    expect(await componentNames()).toEqual(before);
    const ok = await createComponent({ name: 'Private RA', sarsSourceCode: '4006', componentType: 'deduction', paidOutsidePayroll: true });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body.data as { paidOutsidePayroll?: boolean }).paidOutsidePayroll).toBe(true);
  });

  it('the CHECK refuses any other writer (23514), and an existing row defaults to false', async () => {
    for (const [type, code] of [['earning', '4006'], ['deduction', '4005'], ['deduction', ' 4002 ']]) {
      await expect(pool.query(
        `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, paid_outside_payroll)
         VALUES ($1, $2, $3, $4, true)`, [f.company, `CHECK ${type} ${code}`, code, type]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    // The code is trimmed as normaliseSarsCode does: a padded 4006 deduction is allowed.
    await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, paid_outside_payroll)
       VALUES ($1, 'CHECK padded', E'\\t4006 ', 'deduction', true)`, [f.company]);
    const salary = (await pool.query<{ p: boolean }>(
      `SELECT paid_outside_payroll AS p FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'`, [f.company])).rows[0]!;
    expect(salary.p).toBe(false);
  });
});

describe('a private RA in the run', () => {
  it('employee A: PAYE 12 440.49, net pay 47 382.39, no 2175 line, 4006 on the certificate', async () => {
    const ra = (await pool.query<{ id: string }>(
      `SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Private RA'`, [f.company])).rows[0]!.id;
    const assigned = await f.call(assignRoute as Route, 'POST', `/api/payroll/employees/${f.employee}/components`, f.employee,
      { body: { componentId: ra, amount: 2_708.59, effectiveFrom: '2026-03-01' } });
    expect(assigned.statusCode, JSON.stringify(assigned.body)).toBe(201);
    // No 2175 account on this company: a deduction through payroll would block approval (journal plan).
    const paid: Array<{ paye: number; net: number; contributions: number; journal: string }> = [];
    for (const month of [3, 4]) {
      const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year: 2026 } });
      const id = String(made.body.data!.id);
      await calculateRun(f, id);
      const approved = await approveRun(f, id);
      expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
      paid.push((await pool.query(
        `SELECT l.paye::float8 AS paye, l.net_pay::float8 AS net, l.retirement_contributions::float8 AS contributions, h.journal_entry_id AS journal
           FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id WHERE l.run_id = $1`, [id])).rows[0]!);
    }
    expect(paid.map(p => [p.paye, p.net, p.contributions])).toEqual([[12_440.49, 47_382.39, 2_708.59], [12_440.49, 47_382.39, 2_708.59]]);
    const accounts = (await pool.query<{ code: string }>(
      `SELECT a.account_code AS code FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
        WHERE jl.journal_entry_id = $1`, [paid[1]!.journal])).rows.map(r => r.code);
    expect(accounts).not.toContain('2175');

    const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
    req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
    req.query = { taxYear: '2027' };
    const out = response();
    let file = '';
    out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
    await (easyfile as Route)(req as never, out.res as never);
    expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
    expect(file.split(/\r\n/)).toContain('4006,5417'); // 2 × 2 708.59 = 5 417.18
  });
});
