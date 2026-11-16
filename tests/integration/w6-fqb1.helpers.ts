/**
 * Wave 6 FQb1 fixtures: two pay runs in ONE month, which the per-month unique (company_id, period_year,
 * period_month) refuses until FQx drops it. Each case drops it inside its own transaction, seeds there, runs the
 * service on that transaction's client (als, as a request does) and rolls everything back, so no other suite on
 * this database ever sees the constraint gone or the rows. Disposable fixture DB only.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';

export const MONTH_KEY = 'payroll_run_headers_company_id_period_year_period_month_key';

export interface Tenant { company: string; user: string; employee: string }

export async function seedTenant(pool: Pool, name: string): Promise<Tenant> {
  const company = crypto.randomUUID();
  const user = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [company, name]);
  await pool.query("INSERT INTO users(id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [user, `${user}@example.invalid`]);
  await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'admin')", [company, user]);
  const employee = String((await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number)
     VALUES ($1, 'FQB1-1', 'Fiona', 'Two-Runs', '2020-01-01', '1985-01-01', '0123456789') RETURNING id`, [company])).rows[0].id);
  return { company, user, employee };
}

export async function dropTenants(pool: Pool, tenants: Tenant[]): Promise<void> {
  const ids = tenants.map((t) => t.company);
  await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ANY($1))', [ids]);
  await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM payroll_external_imports WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [tenants.map((t) => t.user)]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
}

export interface RunSpec {
  year: number; month: number; status?: string; runDate: string; offCycle?: boolean;
  gross?: number; paye?: number; approvedAt?: string | null; calculatedAt?: string; journal?: string | null;
  /** The line's validation_results; default none. */
  validation?: unknown[];
  /** The line's medical_credit (NULL: not recorded); default 0. */
  medicalCredit?: number | null;
}

/** A header (regular, or off-cycle bonus over the same calendar month) and one line for the tenant's employee. */
export async function seedRun(c: PoolClient, t: Tenant, r: RunSpec): Promise<string> {
  const start = `${r.year}-${String(r.month).padStart(2, '0')}-01`;
  const gross = r.gross ?? 10000;
  const paye = r.paye ?? 1000;
  const status = r.status ?? 'approved';
  const approvedAt = r.approvedAt === undefined ? (status === 'approved' ? r.runDate : null) : r.approvedAt;
  const id = String((await c.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date, total_gross, total_taxable,
       total_paye, total_net, employee_count, run_kind, off_cycle_reason, period_start, period_end, approved_at, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5::date, $6::numeric, $6::numeric, $7::numeric, $6::numeric - $7::numeric, 1, $8, $9, $10::date,
       ($10::date + INTERVAL '1 month - 1 day')::date, $11::timestamptz, $12::uuid)
     RETURNING id`,
    [t.company, r.month, r.year, status, r.runDate, gross, paye, r.offCycle ? 'off_cycle' : 'regular', r.offCycle ? 'bonus' : null,
      start, approvedAt, r.journal ?? null])).rows[0].id);
  await c.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, periodic_taxable, paye, net_pay, validation_results,
       medical_credit, created_at)
     VALUES ($1, $2, $3::numeric, $3::numeric, $3::numeric, $4::numeric, $3::numeric - $4::numeric, $5::jsonb, $6::numeric, $7::timestamptz)`,
    [id, t.employee, gross, paye, JSON.stringify(r.validation ?? []), r.medicalCredit === undefined ? 0 : r.medicalCredit,
      r.calculatedAt ?? r.runDate]);
  return id;
}

/** Drop the per-month unique, run `seed` then `fn` on one transaction-bound client as `t`, and roll it all back. */
export async function twoRunsInMonth<T>(pool: Pool, t: Tenant, seed: (c: PoolClient) => Promise<void>, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE payroll_run_headers DROP CONSTRAINT ${MONTH_KEY}`);
    await seed(client);
    return await als.run({ client, userId: t.user, companyId: t.company, claims: { sub: t.user } } as never, fn);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
