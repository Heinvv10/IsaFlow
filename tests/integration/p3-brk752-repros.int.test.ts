/**
 * Audit 2026-10-18 P3: the adversarial breaker's repros against PR #752 round 1,
 * ported. Each failed on 33533ae3c; each now pins the behaviour the fix chose.
 * Real routes (withAuth, app_user, RLS); disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures, codes,
  createRunFor, directivePayments, runLine, seedRetrenchedEmployee, SALARY_PAYE, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('BRK-1: a user lump-sum component (39xx) with no directive', () => {
  it('is never paid with zero PAYE: approval is refused', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'BRK1 lump sum no directive');
    fixtures.push(f);
    const comp = (await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
       VALUES ($1, 'Gratuity (manual)', '3901', 'earning') RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
       VALUES ($1, $2, 50000, '2026-06-01', '2026-06-30')`, [f.employee, comp]);
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    const l = await runLine(pool, june, f.employee);
    expect(l.gross).toBe(70_000);
    const approved = await approveRun(f, june);
    expect(l.paye).toBe(SALARY_PAYE); // no PAYE from the lump sum…
    expect(approved.statusCode).toBe(400); // …so it cannot be approved
  });
});

describe('BRK-2: ETI on a severance-only line of an employee who left before the period', () => {
  it('claims no ETI for a month the employee was not employed', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-04-30', 'BRK2 eti severance only');
    fixtures.push(f);
    await pool.query(`UPDATE payroll_employees SET date_of_birth = '2001-01-01', start_date = '2025-06-01' WHERE id = $1`, [f.employee]);
    await pool.query(`UPDATE payroll_employee_components SET amount = 6000 WHERE employee_id = $1`, [f.employee]);
    await approvedDirective(f, 3000, 0.1, '2026-05-05');
    const may = await createRunFor(f, 5);
    await calculateRun(f, may);
    const l = (await pool.query(`SELECT gross_pay::float8 AS gross, eti::float8 AS eti FROM payroll_run_lines WHERE run_id = $1`, [may])).rows[0];
    const h = (await pool.query(`SELECT total_eti::float8 AS eti FROM payroll_run_headers WHERE id = $1`, [may])).rows[0];
    expect(l.gross).toBe(3000);
    expect(l.eti).toBe(0);
    expect(h.eti).toBe(0);
  });
});

describe('BRK-3: a directive whose rate exceeds 100%', () => {
  it('is not payable: the run leaves the severance out and nothing is claimed', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-03-31', 'BRK3 rate over 1');
    fixtures.push(f);
    // The tax-directives route now refuses a rate above 1; the service is reached directly here.
    const d = await approvedDirective(f, 10_000, 1.5, '2026-03-05');
    const mar = await createRunFor(f, 3);
    await calculateRun(f, mar);
    const l = await runLine(pool, mar, f.employee);
    expect(l.gross).toBe(20_000);
    expect(codes(l.validation_results)).toContain('SEVERANCE_AWAITING_DIRECTIVE');
    expect((await approveRun(f, mar)).statusCode).toBe(200);
    expect(await directivePayments(pool, d)).toEqual([]);
  });
});

describe('BRK-4: the claiming run is reopened and recalculated without the severance (end date moved)', () => {
  it('its posted journal still pays it, so nothing else may; once that journal is reversed and the run re-approved, the next run pays it', async () => {
    const { calculatedSeverance, reopenRun, applyStandalone } = await import('./p3-severance.helpers');
    const jeAction = (await import('../../pages/api/accounting/journal-entries-action')).default;
    const f = await seedRetrenchedEmployee(pool, '2026-07-31', 'BRK4 end date moved');
    fixtures.push(f);
    const d = await approvedDirective(f, calculatedSeverance('2026-07-31'), 0.1, '2026-07-01');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    expect((await approveRun(f, july)).statusCode).toBe(200);
    expect((await reopenRun(f, july)).statusCode).toBe(200);
    await pool.query(`UPDATE payroll_employees SET end_date = '2026-08-31' WHERE id = $1`, [f.employee]);
    await calculateRun(f, july);
    expect((await runLine(pool, july, f.employee)).gross).toBe(20_000);

    // July's journal, in force, still books the severance: August and the stand-alone path are refused it.
    const aug = await createRunFor(f, 8);
    await calculateRun(f, aug);
    expect(codes((await runLine(pool, aug, f.employee)).validation_results)).toContain('SEVERANCE_PAID_BY_DIRECTIVE');
    expect((await applyStandalone(f, d, '2026-09-15')).statusCode).toBe(409);
    expect((await approveRun(f, july)).body.error?.message).toMatch(/Reverse journal/);

    // Reverse July's journal and approve July again: its claim goes with the line.
    const journal = String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [july])).rows[0]!.journal_entry_id);
    const reversed = await f.call(jeAction as never, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } });
    expect(reversed.statusCode).toBe(200);
    expect((await approveRun(f, july)).statusCode).toBe(200);
    expect(await directivePayments(pool, d)).toEqual([]);
    await calculateRun(f, aug);
    expect((await runLine(pool, aug, f.employee)).gross).toBeCloseTo(20_000 + calculatedSeverance('2026-07-31'), 2);
  });
});

describe('BRK-5: a negative annual-payment earning (bonus clawback, 3605)', () => {
  it('reduces the PAYE as it reduces the taxable pay', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-12-31', 'BRK5 negative 3605');
    fixtures.push(f);
    const comp = (await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
       VALUES ($1, 'Bonus clawback', '3605', 'earning') RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
       VALUES ($1, $2, -5000, '2026-06-01', '2026-06-30')`, [f.employee, comp]);
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    const l = await runLine(pool, june, f.employee);
    expect(l.gross).toBe(15_000);
    expect(l.paye).toBeLessThan(SALARY_PAYE);
  });
});

describe('BRK-6: severance captured as a 3901 component AND its directive approved', () => {
  it('pays the severance once', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-06-30', 'BRK6 double severance');
    fixtures.push(f);
    const comp = (await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
       VALUES ($1, 'Severance (captured)', '3901', 'earning') RETURNING id`, [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
       VALUES ($1, $2, 30000, '2026-06-01', '2026-06-30')`, [f.employee, comp]);
    await approvedDirective(f, 30_000, 0.1, '2026-06-01');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    const l = await runLine(pool, june, f.employee);
    const approved = await approveRun(f, june);
    expect(l.gross).toBe(50_000);
    expect(codes(l.validation_results)).toContain('SEVERANCE_CAPTURED_AS_COMPONENT');
    expect(approved.statusCode).toBe(400); // the hand-made component has no directive
  });
});
