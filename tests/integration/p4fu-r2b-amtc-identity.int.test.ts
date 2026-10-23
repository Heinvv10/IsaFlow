/**
 * PAYE 4a follow-ups round 2, R3 part 2 (Hein 2026-10-23): the additional
 * medical expenses tax credit for 65 and older changes the PAYE of an
 * employee 65 or older whose medical scheme fees (deductions coded 4005)
 * exceed three times the medical scheme fees tax credit, and of NO ONE ELSE.
 *
 * fixtures/p4fu-r2b-amtc-identity.golden.json holds every line's PAYE of this
 * fixture's March, April and May runs, written by the code BEFORE the credit
 * was built (`PAYE_GOLDEN_WRITE=1`, at f8d83e209). Every employee except E5
 * must reproduce it to the cent; E5's PAYE falls by exactly the credit.
 *
 * Employees (2027 tax year, real routes, cumulative PAYE):
 *   E0 born 1980, no medical aid, R20 000
 *   E1 born 1986, member + 1, R3 000 medical aid (4005), R30 000
 *   E2 born 1986, no medical aid, R25 000
 *   E3 born 1956 (70 at 28 Feb 2027), member + 1, no 4005 deduction, R30 000
 *   E4 born 1956, no medical aid, R18 000
 *   E5 born 1959 (67), member + 1, R5 100 medical aid, R30 000
 *   E6 born 1960 (66), member only, R1 000 medical aid (under 3 x the credit), R20 000
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const GOLDEN = join(__dirname, 'fixtures', 'p4fu-r2b-amtc-identity.golden.json');
let f: SeveranceFixture;
let paye: Record<string, number> = {};

const EMPLOYEES = [
  { number: 'E1', born: '1986-06-15', salary: 30_000, member: true, dependants: 1, fees: 3_000 },
  { number: 'E2', born: '1986-06-15', salary: 25_000, member: false, dependants: 0, fees: 0 },
  { number: 'E3', born: '1956-06-15', salary: 30_000, member: true, dependants: 1, fees: 0 },
  { number: 'E4', born: '1956-06-15', salary: 18_000, member: false, dependants: 0, fees: 0 },
  { number: 'E5', born: '1959-06-15', salary: 30_000, member: true, dependants: 1, fees: 5_100 },
  { number: 'E6', born: '1960-06-15', salary: 20_000, member: true, dependants: 0, fees: 1_000 },
];

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2027-02-28', 'R3 AMTC identity');
  await pool.query(`UPDATE payroll_employees SET status = 'active', employee_number = 'E0' WHERE id = $1`, [f.employee]);
  await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
     VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [f.company]);
  const salary = (await pool.query<{ id: string }>(
    `SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'`, [f.company])).rows[0]!.id;
  const medical = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1, 'Medical aid', '4005', 'deduction', false) RETURNING id`, [f.company])).rows[0]!.id;
  for (const e of EMPLOYEES) {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth,
                                      medical_aid_main_member, medical_aid_dependants_count)
       VALUES ($1, $2, 'Emp', $2, '2020-01-01', $3::date, $4, $5) RETURNING id`,
      [f.company, e.number, e.born, e.member, e.dependants])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')`,
      [id, salary, e.salary]);
    if (e.fees > 0) {
      await pool.query(
        `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')`,
        [id, medical, e.fees]);
    }
  }
  for (const month of [3, 4, 5]) {
    const run = await createRunFor(f, month);
    await calculateRun(f, run);
    const approved = await approveRun(f, run);
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
  }
  const rows = (await pool.query<{ k: string; paye: number }>(
    `SELECT e.employee_number || ' ' || h.period_month AS k, l.paye::float8 AS paye
       FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id JOIN payroll_employees e ON e.id = l.employee_id
      WHERE h.company_id = $1 ORDER BY 1`, [f.company])).rows;
  paye = Object.fromEntries(rows.map(r => [r.k, r.paye]));
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f].filter(Boolean)); } finally { await pool.end(); }
});

describe('R3 part 2: the additional medical credit moves only the PAYE it should', () => {
  if (process.env.PAYE_GOLDEN_WRITE === '1') {
    it('writes the golden file', () => { writeFileSync(GOLDEN, `${JSON.stringify(paye, null, 1)}\n`); });
    return;
  }

  it('every line of every other employee (under 65, no medical aid, 65+ without or under the excess) is byte-identical', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, number>;
    expect(Object.keys(paye).sort()).toEqual(Object.keys(golden).sort());
    const others = Object.keys(golden).filter(k => !k.startsWith('E5 '));
    expect(others).toHaveLength(18);
    for (const k of others) expect(paye[k], k).toBe(golden[k]);
  });

  it('E5 (67, R5 100 a month, member + 1): the year\'s tax falls by the credit, 11 364.624, spread cumulatively', () => {
    // 33,3% x (61 200 - 3 x 9 024) = 33,3% x 34 128 = 11 364.624 a year (SARS Guide on the Determination of
    // Medical Tax Credits, Issue 18, p. 31-32). tax(360 000) = 73 992 - 17 820 - 9 765 - 9 024 = 37 383:
    // 3 115.25 a month before. After: 37 383 - 11 364.624 = 26 018.376 a year; cumulatively
    // March 26 018.376 / 12 = 2 168.198 -> 2 168.20; April 4 336.396 - 2 168.20 = 2 168.196 -> 2 168.20;
    // May 6 504.594 - 4 336.40 = 2 168.194 -> 2 168.19.
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, number>;
    expect([3, 4, 5].map(m => golden[`E5 ${m}`])).toEqual([3_115.25, 3_115.25, 3_115.25]);
    expect([3, 4, 5].map(m => paye[`E5 ${m}`])).toEqual([2_168.2, 2_168.2, 2_168.19]);
  });
});
