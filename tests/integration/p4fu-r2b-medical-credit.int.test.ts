/**
 * PAYE 4a follow-ups round 2, R3 (storage): a run line records the medical
 * scheme fees tax credit its PAYE took into account (payroll_run_lines.
 * medical_credit, migration 926), and the next month's year-to-date carries
 * the credits recorded so far (loadPayeYearToDate), so the year's lines add up
 * to the credit inside the year's PAYE. PAYE itself is unchanged
 * (tests/unit/services/payroll/payeMedicalCreditIdentity.test.ts).
 *
 * Fixture: R20 000 a month, born 1980, medical aid member + 1 dependant
 * (2 x R376 a month, G21 2027 p. 10-11). tax(240 000) = 43 200 - 17 820 =
 * 25 380 > the 9 024 credit, so each month uses 752 and PAYE is
 * (25 380 - 9 024) / 12 = 1 363.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import {
  approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let f: SeveranceFixture;
const runs: Record<number, string> = {};

const line = async (runId: string) => (await pool.query(
  `SELECT paye::float8 AS paye, medical_credit::float8 AS medical_credit
     FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [runId, f.employee])).rows[0];

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2027-01-31', 'R3 medical credit');
  await pool.query(
    `UPDATE payroll_employees SET medical_aid_main_member = true, medical_aid_dependants_count = 1, status = 'active'
      WHERE id = $1`, [f.employee]);
  for (const month of [3, 4]) {
    runs[month] = await createRunFor(f, month);
    await calculateRun(f, runs[month]!);
    expect((await approveRun(f, runs[month]!)).statusCode).toBe(200);
  }
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f].filter(Boolean)); } finally { await pool.end(); }
});

describe('R3: payroll_run_lines.medical_credit', () => {
  it('migration 926: a nullable numeric column', async () => {
    const col = (await pool.query(
      `SELECT data_type, is_nullable, numeric_precision, numeric_scale FROM information_schema.columns
        WHERE table_name = 'payroll_run_lines' AND column_name = 'medical_credit'`)).rows[0];
    expect(col).toEqual({ data_type: 'numeric', is_nullable: 'YES', numeric_precision: 14, numeric_scale: 2 });
  });

  it('each month records the credit its PAYE used; PAYE is the same as without the record', async () => {
    expect(await line(runs[3]!)).toEqual({ paye: 1_363, medical_credit: 752 });
    expect(await line(runs[4]!)).toEqual({ paye: 1_363, medical_credit: 752 });
  });

  it('the year-to-date carries the credits recorded on the approved earlier months', async () => {
    const ytd = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 5 }, [f.employee]);
    expect(ytd.get(f.employee)).toMatchObject({ periods: 2, tablePaye: 2_726, medicalCredit: 1_504 });
  });

  it('a line from before the migration (NULL) counts as nothing recorded, and the next line carries its credit', async () => {
    await pool.query('UPDATE payroll_run_lines SET medical_credit = NULL WHERE run_id = $1', [runs[3]]);
    const ytd = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 5 }, [f.employee]);
    expect(ytd.get(f.employee)?.medicalCredit).toBe(752);
    const may = await createRunFor(f, 5);
    await calculateRun(f, may);
    // Credit to date 9 024 x 3/12 = 2 256, of which April recorded 752.
    expect(await line(may)).toEqual({ paye: 1_363, medical_credit: 1_504 });
  });
});
