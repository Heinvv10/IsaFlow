/**
 * Wave 5 FB: migration 970's backfill of the medical_gross_up opt-in for existing 3810 users (split out of
 * mp-w5-fringe-benefits-api.int.test.ts for the 300-line cap). Real Postgres (disposable fixture only). The migration file
 * itself is run, twice, INSIDE a transaction that is rolled back: no row it writes survives for another suite, and any
 * row for a company other than this test's is counted and refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const mig = readFileSync(`${__dirname}/../../scripts/migrations/sql/970_payroll_employee_fringe_benefits.sql`, 'utf8');
const co = { A: crypto.randomUUID(), B: crypto.randomUUID() };
const ids: Record<string, string> = {};
type Row = { kind: string; from: string; to: string | null; by: string };
const rows: Record<string, Row[]> = {};
let foreign = -1;
let ownCompany = false;

async function company(id: string): Promise<string> {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `FB backfill ${id.slice(0, 8)}`]);
  return (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1, 'Employer medical', '3810', 'earning', true) RETURNING id`, [id])).rows[0]!.id;
}
const run = (c: string, month: number, status: string) => pool.query(
  'INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross) VALUES ($1, $2, 2026, $3, 0)', [c, month, status]);
async function emp(c: string, comp: string, n: string, assignments: Array<[string, string | null]>): Promise<void> {
  ids[n] = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1, $2, 'B', $2, '2020-01-01') RETURNING id`, [c, n])).rows[0]!.id;
  for (const [from, to] of assignments) {
    await pool.query('INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to) VALUES ($1, $2, 2000, $3, $4)', [ids[n], comp, from, to]);
  }
}

beforeAll(async () => {
  const cA = await company(co.A);
  const cB = await company(co.B);
  // An approved August run (approved runs are reopenable, so no month is final): its 3810 users must stay cash.
  await run(co.A, 8, 'approved');
  await emp(co.A, cA, 'BF-ACTIVE', [['2024-05-10', null], ['2025-03-01', null]]);
  await emp(co.A, cA, 'BF-HIRE', [['2026-11-20', null]]);
  await emp(co.A, cA, 'BF-LEAVER', [['2025-02-10', '2026-11-30']]);
  await emp(co.A, cA, 'BF-TWO', [['2025-02-10', '2026-08-15'], ['2026-08-16', '2026-10-31']]);
  await emp(co.A, cA, 'BF-AUG', [['2025-02-10', '2026-08-31']]);
  await emp(co.A, cA, 'BF-LONG', [['2023-01-10', '2024-12-31']]);
  await emp(co.A, cA, 'BF-VOID', [['2026-05-10', '2026-05-01']]);
  await emp(co.A, cA, 'BF-NONE', []);
  // Another company's employee gets a row of its own company, never company A's.
  await emp(co.B, cB, 'BF-OTHER', [['2025-06-15', null]]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(mig);
    await client.query(mig);
    for (const [n, id] of Object.entries(ids)) {
      rows[n] = (await client.query<Row>(
        "SELECT kind, to_char(effective_from,'YYYY-MM-DD') AS from, to_char(effective_to,'YYYY-MM-DD') AS to, created_by AS by FROM payroll_employee_fringe_benefits WHERE employee_id = $1", [id])).rows;
    }
    ownCompany = (await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM payroll_employee_fringe_benefits f JOIN payroll_employees e ON e.id = f.employee_id
        WHERE f.created_by = 'migration:970' AND f.company_id <> e.company_id`)).rows[0]!.n === '0';
    foreign = Number((await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM payroll_employee_fringe_benefits WHERE created_by = 'migration:970' AND company_id <> ALL($1::uuid[])", [Object.values(co)])).rows[0]!.n);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, Object.values(co));
  } finally { await pool.end(); }
});

const gross = (from: string, to: string | null): Row[] => [{ kind: 'medical_gross_up', from, to, by: 'migration:970' }];

describe('migration 970 backfills the gross-up opt-in for every employee who has had a 3810 assignment, once', () => {
  it('an open assignment: from the first of the month it started, open-ended, created by the migration', () => {
    expect(rows['BF-ACTIVE']).toEqual(gross('2024-05-01', null));
  });
  it('a hire on 11-20 stays cash for all of November (the row starts 11-01)', () => {
    expect(rows['BF-HIRE']).toEqual(gross('2026-11-01', null));
  });
  it('a leaver ending 11-30 stays cash in November: the row ends at that month end', () => {
    expect(rows['BF-LEAVER']).toEqual(gross('2025-02-01', '2026-11-30'));
  });
  it('several assignments none open-ended: one row to the month end of the last to end', () => {
    expect(rows['BF-TWO']).toEqual(gross('2025-02-01', '2026-10-31'));
  });
  it('an approved (reopenable) August stays cash: a 3810 ending 08-31 has a row ending 08-31', () => {
    expect(rows['BF-AUG']).toEqual(gross('2025-02-01', '2026-08-31'));
  });
  it('a long-ended assignment gets a row ending at its month end (it changes nothing unless that month is recomputed)', () => {
    expect(rows['BF-LONG']).toEqual(gross('2023-01-01', '2024-12-31'));
  });
  it('an employee with no 3810, and a voided assignment (ends before it starts), get none', () => {
    expect(rows['BF-NONE']).toEqual([]);
    expect(rows['BF-VOID']).toEqual([]);
  });
  it('each row belongs to its own company; the re-run added no second row', () => {
    expect(rows['BF-OTHER']).toEqual(gross('2025-06-01', null));
    expect(rows['BF-ACTIVE']).toHaveLength(1);
    expect(ownCompany).toBe(true);
  });
  it('writes rows only for these companies, and nothing survives the rolled-back transaction', async () => {
    expect(foreign).toBe(0);
    const left = await pool.query("SELECT count(*) AS n FROM payroll_employee_fringe_benefits WHERE created_by = 'migration:970' AND company_id = ANY($1::uuid[])", [Object.values(co)]);
    expect(Number((left.rows[0] as { n: string }).n)).toBe(0);
  });
});
