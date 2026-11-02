/**
 * A leaver paid their severance alone in a later run (payrollRunTermination.severanceOnlyComponents) has it checked
 * against the severance calculated on the pay they left on: the salary in force on their END DATE, not on the run's
 * read date or the day either side of it. The salary here is different the day before, on, and after the exit day, so
 * reading any other day calculates a different severance and raises SEVERANCE_DIRECTIVE_MISMATCH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  approvedDirective, calculatedSeverance, calculateRun, cleanSeveranceFixtures, codes, createRunFor, runLine,
  seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const EXIT = '2026-04-15';
let f: SeveranceFixture;

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, EXIT, 'P3 salary at exit');
  // seedPayrollCompany gave one open salary row from 2020 (MONTHLY = 20 000). Split it around the exit day.
  const { rows } = await pool.query(
    `UPDATE payroll_employee_components SET amount = 15000, effective_to = '2026-04-14'
      WHERE employee_id = $1 RETURNING component_id`,
    [f.employee],
  );
  const salary = String(rows[0]!.component_id);
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to)
     VALUES ($1,$2,20000,'2026-04-15','2026-04-15'), ($1,$2,25000,'2026-04-16',NULL)`,
    [f.employee, salary],
  );
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f]); } finally { await pool.end(); }
});

describe('severance-only line: the salary at exit is read on the end date', () => {
  it('a directive matching the severance on the exit-day salary (R20 000) raises no mismatch', async () => {
    const severance = calculatedSeverance(EXIT);
    await approvedDirective(f, severance, 0.1, '2026-05-05');
    const may = await createRunFor(f, 5);
    await calculateRun(f, may);
    const line = await runLine(pool, may, f.employee);
    expect((line.component_breakdown as Array<{ sarsSourceCode: string }>).map(c => c.sarsSourceCode)).toEqual(['3901']);
    expect(line.gross).toBeCloseTo(severance, 2);
    expect(codes(line.validation_results)).not.toContain('SEVERANCE_DIRECTIVE_MISMATCH');
  });
});
