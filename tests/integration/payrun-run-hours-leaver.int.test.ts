/**
 * HD: a severance-only leaver (paid after leaving, no hours in the period) is not judged on hours, so a run whose only
 * line for an hourly employee is their severance approves. The employee is hourly only AFTER leaving (the April run, as
 * a monthly employee, paid them); the May run carries the severance line alone (P3).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures, codes, createRunFor, previewRun, runLine,
  seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { fixtures.push(await seedRetrenchedEmployee(pool, '2026-04-30', 'HD hourly leaver')); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('HD: an hourly leaver paid severance only', () => {
  it('the severance-only line has no hours flag and the run approves', async () => {
    const f = fixtures[0]!;
    const april = await createRunFor(f, 4);
    await calculateRun(f, april);
    expect((await approveRun(f, april)).statusCode).toBe(200);
    await pool.query(`UPDATE payroll_employees SET pay_basis = 'hourly', hourly_rate = 85.5, hours_per_week = 40, hours_per_day = 8 WHERE id = $1`, [f.employee]);
    await approvedDirective(f, 30_000, 0.1, '2026-05-05');
    const may = await createRunFor(f, 5);
    await calculateRun(f, may);
    const sev = await runLine(pool, may, f.employee);
    expect(sev).toMatchObject({ gross: 30_000, paye: 3_000, net: 27_000 });
    expect(codes(sev.validation_results).filter((c: string) => c.startsWith('HOURS_'))).toEqual([]);
    expect((await previewRun(f, may)).body.data?.blocker ?? null).toBeNull();
    expect((await approveRun(f, may)).statusCode).toBe(200);
  });
});
