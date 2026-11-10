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
const co = { A: crypto.randomUUID(), LATE: crypto.randomUUID(), NORUN: crypto.randomUUID(), CANC: crypto.randomUUID(), DRAFT: crypto.randomUUID() };
const ids: Record<string, string> = {};
type Row = { kind: string; from: string; to: string | null; by: string };
const rows: Record<string, Row[]> = {};
let foreign = -1;
let lastMonthEnd = '';
let monthBeforeEnd = '';

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
  const d = (await pool.query<{ a: string; b: string }>(
    `SELECT to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 day', 'YYYY-MM-DD') AS a,
            to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' - INTERVAL '1 day', 'YYYY-MM-DD') AS b`)).rows[0]!;
  lastMonthEnd = d.a; monthBeforeEnd = d.b;
  const cA = await company(co.A);
  const cLate = await company(co.LATE);
  const cNo = await company(co.NORUN);
  const cCanc = await company(co.CANC);
  const cDraft = await company(co.DRAFT);
  // A: the earliest draft or calculated run is July 2026, so its window opens on 2026-07-01.
  await run(co.A, 7, 'calculated');
  await emp(co.A, cA, 'BF-ACTIVE', [['2024-05-10', null], ['2025-03-01', null]]);
  await emp(co.A, cA, 'BF-HIRE', [['2026-11-20', null]]);
  await emp(co.A, cA, 'BF-LEAVER', [['2025-02-10', '2026-11-30']]);
  await emp(co.A, cA, 'BF-TWO', [['2025-02-10', '2026-08-15'], ['2026-08-16', '2026-10-31']]);
  await emp(co.A, cA, 'BF-ENDED', [['2023-01-01', '2024-12-31']]);
  await emp(co.A, cA, 'BF-JUNE', [['2025-01-01', '2026-06-30']]);
  await emp(co.A, cA, 'BF-NONE', []);
  // LATE: no draft or calculated run, the latest final run is August: the window opens on 2026-09-01, not last month.
  await run(co.LATE, 8, 'approved');
  await emp(co.LATE, cLate, 'LATE-SEP', [['2025-01-01', '2026-09-30']]);
  await emp(co.LATE, cLate, 'LATE-AUG', [['2025-01-01', '2026-08-31']]);
  // NORUN: no run at all, the window opens on the first of last month.
  await emp(co.NORUN, cNo, 'NO-LASTMONTH', [['2025-01-01', lastMonthEnd]]);
  await emp(co.NORUN, cNo, 'NO-OLDER', [['2025-01-01', monthBeforeEnd]]);
  // CANC: a cancelled January run does not open the window (only draft / calculated do); July does.
  await run(co.CANC, 1, 'cancelled');
  await run(co.CANC, 7, 'calculated');
  await emp(co.CANC, cCanc, 'CANC-MARCH', [['2025-01-01', '2026-03-31']]);
  // DRAFT: its own February draft run opens ITS window; it must not open CANC's.
  await run(co.DRAFT, 2, 'draft');
  await emp(co.DRAFT, cDraft, 'DRAFT-MARCH', [['2025-01-01', '2026-03-15']]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(mig);
    await client.query(mig);
    for (const [n, id] of Object.entries(ids)) {
      rows[n] = (await client.query<Row>(
        "SELECT kind, to_char(effective_from,'YYYY-MM-DD') AS from, to_char(effective_to,'YYYY-MM-DD') AS to, created_by AS by FROM payroll_employee_fringe_benefits WHERE employee_id = $1", [id])).rows;
    }
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

describe('migration 970 backfills the gross-up opt-in for existing 3810 users, once, inside the window a run can compute', () => {
  it('an open assignment: from the first of the month it started, open-ended, created by the migration', () => {
    expect(rows['BF-ACTIVE']).toEqual(gross('2024-05-01', null));
  });
  it('a hire on 11-20 stays cash for all of November (the row starts 11-01)', () => {
    expect(rows['BF-HIRE']).toEqual(gross('2026-11-01', null));
  });
  it('a leaver ending 11-30, inside the window (July onwards), stays cash: the row ends at that month end', () => {
    expect(rows['BF-LEAVER']).toEqual(gross('2025-02-01', '2026-11-30'));
  });
  it('several assignments none open-ended: one row to the month end of the last to end', () => {
    expect(rows['BF-TWO']).toEqual(gross('2025-02-01', '2026-10-31'));
  });
  it('assignments that ended before the window, and employees with no 3810, get none; the re-run added no second row', () => {
    for (const n of ['BF-ENDED', 'BF-JUNE', 'BF-NONE']) expect(rows[n]).toEqual([]);
    expect(rows['BF-ACTIVE']).toHaveLength(1);
  });
  it('a late company (latest final run August, no draft): a 3810 ending 09-30 gets a row covering September; one ending 08-31 none', () => {
    expect(rows['LATE-SEP']).toEqual(gross('2025-01-01', '2026-09-30'));
    expect(rows['LATE-AUG']).toEqual([]);
  });
  it('a company with no run: the window opens on the first of last month', () => {
    expect(rows['NO-LASTMONTH']).toEqual(gross('2025-01-01', lastMonthEnd));
    expect(rows['NO-OLDER']).toEqual([]);
  });
  it('a cancelled run does not open the window, and another company\'s draft run does not either', () => {
    expect(rows['CANC-MARCH']).toEqual([]);
    expect(rows['DRAFT-MARCH']).toEqual(gross('2025-01-01', '2026-03-31'));
  });
  it('writes rows only for these companies, and nothing survives the rolled-back transaction', async () => {
    expect(foreign).toBe(0);
    const left = await pool.query("SELECT count(*) AS n FROM payroll_employee_fringe_benefits WHERE created_by = 'migration:970' AND company_id = ANY($1::uuid[])", [Object.values(co)]);
    expect(Number((left.rows[0] as { n: string }).n)).toBe(0);
  });
});
