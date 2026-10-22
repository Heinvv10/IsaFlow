/**
 * Audit 2026-10-18 P3: severance paid in a run reaches EMP201, the IRP5 data
 * and the e@syFile file with the run's own figures.
 *
 * SARS PAYE-GEN-01-G21 (2027) Rev 1, p. 22: "The full amount reflects under
 * code 3901 and the tax under code 4115 on the IRP5 certificate."
 * SARS BRS PAYE Employer Reconciliation V25.2.0 (Apr-26), "Directive
 * Information", p. 41–44
 * (https://www.sars.gov.za/wp-content/uploads/Docs/PAYE/BRS/SARS_PAYE_BRS-PAYE-Employer-Reconciliation_V25-1-0.pdf,
 * which serves V25 2 0): a lump-sum directive is the group
 * 3230 directive no, 3231 issued date, 3232 income source code, 3233 income
 * amount (the 3234 type indicator is optional and not emitted).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import type { Route } from './w3-01-payroll.helpers';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import {
  approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, seedRetrenchedEmployee,
  SALARY_PAYE, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let f: SeveranceFixture;
const APRIL_PAYE = SALARY_PAYE + 2192;

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2026-04-30', 'P3 filing');
  await pool.query(
    `UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
       sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000',
       physical_address_line1 = '1 Main Road', physical_city = 'Pretoria', physical_postal_code = '0181'
     WHERE id = $1`, [f.company]);
  // An April bonus (3605): 20 000 × 12 = 240 000 → 25 380; + 10 000 = 250 000 →
  // 44 118 + 0.26 × 4 900 − 17 820 = 27 572; bonus PAYE 2 192 (2027 tables).
  const bonus = (await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
     VALUES ($1, 'Bonus', '3605', 'earning') RETURNING id`, [f.company])).rows[0]!.id;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
     VALUES ($1, $2, 10000, '2026-04-01', '2026-04-30')`, [f.employee, bonus]);
  const april = await createRunFor(f, 4);
  await calculateRun(f, april);
  expect((await approveRun(f, april)).statusCode).toBe(200);
  await approvedDirective(f, 30_000, 0.1, '2026-05-05', '9876543210');
  const may = await createRunFor(f, 5);
  await calculateRun(f, may);
  expect((await approveRun(f, may)).statusCode).toBe(200);
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f]); } finally { await pool.end(); }
});

describe('P3: filing carries severance paid by directive in the run', () => {
  it("EMP201 for May declares the directive's PAYE", async () => {
    const may = await generateEMP201(f.company, '2026-05-01', '2026-05-31');
    expect(may.totalPAYE).toBe(3_000);
    const april = await generateEMP201(f.company, '2026-04-01', '2026-04-30');
    expect(april.totalPAYE).toBe(APRIL_PAYE);
  });

  it('the IRP5 data shows 3901 at the directive gross, its number, and PAYE including it', async () => {
    const data = await getIrp5EmployeeTotals(f.company, 2027, { employeeId: f.employee });
    expect(data.rows).toHaveLength(1);
    const row = data.rows[0]!;
    expect(row.paye).toBe(APRIL_PAYE + 3_000);
    expect(row.grossSalary).toBe(60_000);
    // No issued date captured: 3231 falls back to the effective date, flagged (PAYE 4a follow-ups G3).
    expect(row.lumpSums).toEqual([expect.objectContaining({
      sourceCode: '3901', directiveNumber: '9876543210', directiveIssuedDate: '2026-05-05', amount: 30_000, paye: 3_000,
      issuedDateFallback: true, payeCode: '4115', paidBy: 'run',
    })]);
  });

  it('the e@syFile file splits 3601 from 3605, 3601/4102 from 3901/4115, and carries the directive group', async () => {
    // The route answers with res.end(file), which the shared response() drops.
    const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as {
      url: string; query: Record<string, unknown>;
    };
    req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027';
    req.query = { taxYear: '2027' };
    const out = response();
    let file = '';
    out.state.end = function end(this: typeof out.state, body?: unknown) { if (typeof body === 'string') file = body; return this; };
    await (easyfile as Route)(req as never, out.res as never);
    expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
    const fields = file.split(/\r\n/);
    for (const want of ['3601,20000', '3605,10000', '4102,4307.00', '3901,30000', '4115,3000.00',
      '3230,"9876543210"', '3231,20260505', '3232,3901', '3233,30000']) {
      expect(fields, want).toContain(want);
    }
  });
});
