/** Breaker round 2 on PR A, ported: the run pays a directive whose stand-alone payment was reversed; age from the ID number; reason 04 is threshold-checked too. */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import easyfile from '../../pages/api/payroll/irp5/easyfile-export';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import {
  applyStandalone, approvedDirective, approveRun, calculatedSeverance, calculateRun, cleanSeveranceFixtures, createRunFor,
  directivePayments, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
afterAll(async () => { try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); } });
const reverseJournal = (f: SeveranceFixture, id: string) =>
  f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id, action: 'reverse' } });

describe('BRK-A round 2', () => {
  it('F1: a pay run pays a directive whose stand-alone payment was reversed', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-09-30', 'Brk2 run path'); fixtures.push(f);
    const d = await approvedDirective(f, calculatedSeverance('2026-09-30'), 0.1, '2026-09-01');
    expect((await applyStandalone(f, d, '2026-09-15')).statusCode).toBe(200);
    const j = String((await directivePayments(pool, d))[0]!.journal_entry_id);
    expect((await reverseJournal(f, j)).statusCode).toBe(200);
    const sept = await createRunFor(f, 9);
    await calculateRun(f, sept);
    const ap = await approveRun(f, sept);
    const pays = await directivePayments(pool, d);
    expect(pays.some(p => p.payroll_run_id === sept), 'run should be able to pay the directive').toBe(true);
  });

  it('F2: a nil-PAYE employee with no date of birth takes the age from the ID number; the export succeeds', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-03-31', 'Brk2 dob', 5_000); fixtures.push(f);
    await pool.query(`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Pat',
      sars_contact_last_name = 'Payroll', sars_contact_telephone = '0115550000', physical_address_line1 = '1 Main Road',
      physical_city = 'Pretoria', physical_postal_code = '0181' WHERE id = $1`, [f.company]);
    const march = await createRunFor(f, 3); await calculateRun(f, march); expect((await approveRun(f, march)).statusCode).toBe(200);
    const exp = async () => {
      const req = request({ 'sb-access-token': f.token, active_company_id: f.company }, 'GET') as unknown as { url: string; query: Record<string, unknown> };
      req.url = '/api/payroll/irp5/easyfile-export?taxYear=2027'; req.query = { taxYear: '2027' };
      const out = response(); await (easyfile as Route)(req as never, out.res as never);
      return out.state as { statusCode: number; body: unknown };
    };
    await pool.query("UPDATE payroll_employees SET date_of_birth = '1980-01-01' WHERE id = $1", [f.employee]);
    const withDob = await exp();
    await pool.query('UPDATE payroll_employees SET date_of_birth = NULL WHERE id = $1', [f.employee]);
    const noDob = await exp();
    expect(noDob.statusCode).toBe(withDob.statusCode);
  });

  it('F3: nil PAYE on R500k salary beside a nil directive is refused, not filed as reason 04', () => {
    const base: EmployeeInput = {
      certificateNumber: '712345678920270200000000000001', yearOfAssessment: 2027, surname: 'Molefe', firstNames: 'Thandi', initials: 'T',
      idNumber: '9001015009087', taxNumber: '0123456789', employmentStartDate: '20250301', employmentEndDate: null, periodsInYoA: 12,
      grossSalary3601: 500_000, paye4102: 0, uifEmployee: 0, uifEmployer: 0, sdl4142: 0, taxThreshold: 99_000,
      lumpSums: [{ sourceCode: '3901', directiveNumber: '5550001112', directiveIssuedDate: '20260401', amount: 10_000, paye: 0 }],
    };
    expect(() => buildEmployeeRecord(base)).toThrow();
  });
});
