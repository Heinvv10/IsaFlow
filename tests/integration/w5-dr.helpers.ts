/**
 * Wave 5 DR integration fixtures: a company with one active R20 000 employee (the P3 fixture, made active), the
 * tax-directives routes, a raw directive insert (for rows the routes refuse: overlaps, other tenants), and a holder of the
 * employee's advisory lock that waits until a request is SEEN waiting on it (pg_locks) before it commits.
 */
import type { Pool } from 'pg';
import directives from '../../pages/api/accounting/tax-directives';
import directive from '../../pages/api/accounting/tax-directives/[id]';
import type { Route } from './w3-01-payroll.helpers';
import { seedRetrenchedEmployee, type SeveranceFixture } from './p3-severance.helpers';

export async function drFixture(pool: Pool, name: string): Promise<SeveranceFixture> {
  const f = await seedRetrenchedEmployee(pool, '2026-04-30', name);
  await pool.query("UPDATE payroll_employees SET end_date = NULL, status = 'active' WHERE id = $1", [f.employee]);
  return f;
}

export const PCT = { directive_type: 'fixed_percentage', tax_rate: 0.2, effective_date: '2026-03-01', directive_number: '1234567' };

export const postDirective = (f: SeveranceFixture, body: Record<string, unknown>) =>
  f.call(directives as Route, 'POST', '/api/accounting/tax-directives', undefined, { body: { employee_id: f.employee, ...body } });
/** An approval goes through the company's OTHER member (f.approver, the owner): the creator may not approve (four eyes). */
export const patchDirective = (f: SeveranceFixture, id: string, body: Record<string, unknown>, user?: string) =>
  f.call(directive as Route, 'PATCH', `/api/accounting/tax-directives/${id}`, id, {
    body, user: user ?? (body.status === 'approved' ? f.approver : f.admin),
  });
export const deleteDirective = (f: SeveranceFixture, id: string) =>
  f.call(directive as Route, 'DELETE', `/api/accounting/tax-directives/${id}`, id);

/** A row written straight to the table (no route guard): for overlaps, other tenants and unusable rows. */
export async function insertDirective(pool: Pool, company: string, employee: string, o: {
  type?: 'fixed_percentage' | 'fixed_amount'; rate?: number | null; amount?: number | null; effective?: string; expiry?: string | null;
  status?: string; number?: string;
} = {}): Promise<string> {
  const type = o.type ?? 'fixed_percentage';
  return String((await pool.query(
    `INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, amount, tax_rate, tax_amount, effective_date, expiry_date, status, directive_number)
     VALUES ($1, $2, 'Wanda Test', $3, 0, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [company, employee, type, type === 'fixed_percentage' ? (o.rate === undefined ? 0.25 : o.rate) : null,
      type === 'fixed_amount' ? (o.amount === undefined ? 2500 : o.amount) : null, o.effective ?? '2026-03-01', o.expiry ?? null,
      o.status ?? 'approved', o.number ?? String(Math.floor(Math.random() * 1e9))])).rows[0]!.id);
}

export const cancelAll = (pool: Pool, f: SeveranceFixture) => pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE company_id = $1", [f.company]);

export const regularRows = async (pool: Pool, company: string) => Number((await pool.query(
  "SELECT count(*) AS n FROM tax_directives WHERE company_id = $1 AND directive_type IN ('fixed_percentage', 'fixed_amount') AND status <> 'cancelled'",
  [company])).rows[0]!.n);

/** Hold advisory lock `key` while `request` runs; report whether it was seen waiting on it before the lock was let go. */
export async function whileLockHeld<T>(pool: Pool, key: string, request: () => Promise<T>): Promise<{ result: T; waited: boolean }> {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    let settled = false;
    const pending = request().finally(() => { settled = true; });
    const waited = await Promise.race([seenWaitingOnAdvisoryLock(pool, pid), pending.then(() => false)]) && !settled;
    await holder.query('COMMIT');
    return { result: await pending, waited };
  } finally {
    holder.release();
  }
}

/** True once a backend other than `except` waits on an advisory lock (polled, up to 15 s). */
async function seenWaitingOnAdvisoryLock(pool: Pool, except: number): Promise<boolean> {
  for (let i = 0; i < 300; i += 1) {
    const r = await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid <> $1", [except]);
    if (Number(r.rows[0]!.n) > 0) return true;
    await new Promise(res => setTimeout(res, 50));
  }
  return false;
}

/**
 * Hold the employee's advisory lock, start `request`, wait until it is seen waiting on that lock, insert a directive
 * under the lock (`insert`), and commit. Returns the request's result and whether it was seen waiting.
 */
export async function underHeldLock<T>(pool: Pool, f: SeveranceFixture, request: () => Promise<T>, insert: { status: 'pending' | 'approved' }): Promise<{ result: T; waited: boolean }> {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    const pid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`tax_directive_regular_pay:${f.company}:${f.employee}`]);
    let settled = false;
    const pending = request().finally(() => { settled = true; });
    const waited = await Promise.race([seenWaitingOnAdvisoryLock(pool, pid), pending.then(() => false)]) && !settled;
    await holder.query(
      `INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, amount, tax_rate, effective_date, status, directive_number)
       VALUES ($1, $2, 'Wanda Test', 'fixed_percentage', 0, 0.25, '2026-03-01', $3, '999999')`, [f.company, f.employee, insert.status]);
    await holder.query('COMMIT');
    return { result: await pending, waited };
  } finally {
    holder.release();
  }
}
