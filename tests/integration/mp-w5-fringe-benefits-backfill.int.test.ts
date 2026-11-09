/**
 * Wave 5 FB: migration 970's backfill of the medical_gross_up opt-in for existing 3810 users (split out of
 * mp-w5-fringe-benefits-api.int.test.ts for the 300-line cap). Real Postgres (disposable fixture only); the migration file
 * itself is run, twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import fringe from '../../pages/api/payroll/employees/[id]/fringe-benefits';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const companyA = crypto.randomUUID();
const owner = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: owner, company: companyA });
const send = (method: string, id: string) => call(fringe as Route, method, `/api/payroll/employees/${id}/fringe-benefits`, id, { user: owner });

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyA, 'FB backfill']);
  await seedPayrollCompany(pool, companyA);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  tokens[owner] = await new SignJWT({ sub: owner, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [companyA, owner, 'owner']);
  // The company's earliest draft or calculated run: July 2026, so the window opens on 2026-07-01.
  await pool.query("INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross) VALUES ($1, 7, 2026, 'calculated', 0)", [companyA]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employee_fringe_benefits WHERE company_id = $1', [companyA]);
    await cleanPayrollCompanies(pool, [companyA]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner]);
  } finally { await pool.end(); }
});

describe('migration 970 backfills the gross-up opt-in for existing 3810 users, once, inside the window a run can compute', () => {
  const mig = readFileSync(`${__dirname}/../../scripts/migrations/sql/970_payroll_employee_fringe_benefits.sql`, 'utf8');
  const ids: Record<string, string> = {};
  const rowsOf = (id: string) => pool.query<{ kind: string; from: string; to: string | null; by: string }>(
    "SELECT kind, to_char(effective_from,'YYYY-MM-DD') AS from, to_char(effective_to,'YYYY-MM-DD') AS to, created_by AS by FROM payroll_employee_fringe_benefits WHERE employee_id = $1", [id]);
  it('seeds employees and runs the migration; a re-run adds nothing', async () => {
    const comp = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Employer medical', '3810', 'earning', true) RETURNING id`, [companyA])).rows[0]!.id;
    const make = async (n: string, rows: Array<[string, string | null]>) => {
      ids[n] = (await pool.query<{ id: string }>(
        `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1, $2, 'B', $2, '2020-01-01') RETURNING id`, [companyA, n])).rows[0]!.id;
      for (const [from, to] of rows) {
        await pool.query('INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to) VALUES ($1, $2, 2000, $3, $4)', [ids[n], comp, from, to]);
      }
    };
    await make('BF-ACTIVE', [['2024-05-10', null], ['2025-03-01', null]]);
    await make('BF-HIRE', [['2026-11-20', null]]);
    await make('BF-LEAVER', [['2025-02-10', '2026-11-30']]);
    await make('BF-TWO', [['2025-02-10', '2026-08-15'], ['2026-08-16', '2026-10-31']]);
    await make('BF-ENDED', [['2023-01-01', '2024-12-31']]);
    await make('BF-JUNE', [['2025-01-01', '2026-06-30']]);
    await make('BF-NONE', []);
    await pool.query(mig);
    await pool.query(mig);
  });
  it('an open assignment: from the first of the month it started, open-ended, created by the migration', async () => {
    expect((await rowsOf(ids['BF-ACTIVE']!)).rows).toEqual([{ kind: 'medical_gross_up', from: '2024-05-01', to: null, by: 'migration:970' }]);
  });
  it('a hire on 11-20 stays cash for all of November (the row starts 11-01)', async () => {
    expect((await rowsOf(ids['BF-HIRE']!)).rows).toEqual([{ kind: 'medical_gross_up', from: '2026-11-01', to: null, by: 'migration:970' }]);
  });
  it('a leaver ending 11-30 with November still a draft stays cash: the row ends at that month end', async () => {
    expect((await rowsOf(ids['BF-LEAVER']!)).rows).toEqual([{ kind: 'medical_gross_up', from: '2025-02-01', to: '2026-11-30', by: 'migration:970' }]);
  });
  it('several assignments none open-ended: one row to the month end of the last to end', async () => {
    expect((await rowsOf(ids['BF-TWO']!)).rows).toEqual([{ kind: 'medical_gross_up', from: '2025-02-01', to: '2026-10-31', by: 'migration:970' }]);
  });
  it('assignments that ended before the window, and employees with no 3810, get none; a re-run added no second row', async () => {
    for (const n of ['BF-ENDED', 'BF-JUNE', 'BF-NONE']) expect((await rowsOf(ids[n]!)).rows).toEqual([]);
    expect((await rowsOf(ids['BF-ACTIVE']!)).rows).toHaveLength(1);
  });
  it('the backfilled opt-in is listed on the profile API as medical_gross_up', async () => {
    const r = await send('GET', ids['BF-ACTIVE']!);
    expect((r.body.data as unknown as Array<{ kind: string }>).map((b) => b.kind)).toEqual(['medical_gross_up']);
  });
});
