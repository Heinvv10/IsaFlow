/**
 * Shared by the migration 947 suites (budgets-version*, budgets-grain*, budgets-amount-tenant-fks,
 * budgets-unique-cell, budgets-p1-*): two companies with one member each, an account, CC1/CC2
 * centres and a business unit per company, versions and amounts written directly, and an
 * app_user session opened exactly as withAuth opens one. Real PostgreSQL; synthetic rows only.
 */
import type { Pool, PoolClient } from 'pg';

export interface Co {
  id: string; user: string; acct: string; acct2: string; cc1: string; cc1b: string; cc2: string; bu: string;
}

export function budgetVersionFixture(pool: Pool) {
  const mk = (): Co => ({
    id: crypto.randomUUID(), user: crypto.randomUUID(), acct: crypto.randomUUID(), acct2: crypto.randomUUID(),
    cc1: crypto.randomUUID(), cc1b: crypto.randomUUID(), cc2: crypto.randomUUID(), bu: crypto.randomUUID(),
  });
  const A = mk(), B = mk();

  async function setupCompany(c: Co, name: string) {
    await pool.query('INSERT INTO companies (id, name, financial_year_start) VALUES ($1, $2, 3)', [c.id, name]);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [c.user, `${c.user}@test.local`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')", [c.id, c.user]);
    await pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
       VALUES ($1, $3, 'BV-5000', 'Rent', 'expense', 'debit', 3, true), ($2, $3, 'BV-6000', 'Wages', 'expense', 'debit', 3, true)`,
      [c.acct, c.acct2, c.id]);
    await pool.query(
      `INSERT INTO cost_centres (id, company_id, code, name, cc_type)
       VALUES ($1, $4, 'BV-C1', 'Cape Town', 'cc1'), ($2, $4, 'BV-C1B', 'Durban', 'cc1'), ($3, $4, 'BV-C2', 'Retail', 'cc2')`,
      [c.cc1, c.cc1b, c.cc2, c.id]);
    await pool.query(`INSERT INTO business_units (id, company_id, code, name) VALUES ($1, $2, 'BV-BU', 'Ops')`, [c.bu, c.id]);
    // Registry years: FY2027 = March 2026 - February 2027, FY2028 = March 2027 - February 2028.
    await pool.query(
      `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
       VALUES ($1, 2027, '2026-03-01', '2027-02-28', 'normal'), ($1, 2028, '2027-03-01', '2028-02-29', 'normal')`, [c.id]);
  }

  async function setup() {
    await setupCompany(A, 'BV947 A');
    await setupCompany(B, 'BV947 B');
  }

  async function cleanup() {
    const ids = [A.id, B.id];
    // Locked versions refuse DELETE (and so the cascade): unlock first, as QA purges do.
    await pool.query(
      `UPDATE budget_versions SET status = 'approved', unlocked_by = locked_by, unlocked_at = now(), unlock_reason = 'test cleanup'
        WHERE company_id = ANY($1) AND status = 'locked'`, [ids]);
    await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM budget_month_amounts WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM budget_versions WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM accounting_budgets WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM cost_centres WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM business_units WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM fiscal_years WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[A.user, B.user]]);
  }

  type Q = Pool | PoolClient;
  /** A version; `status` approved/locked is reached through the legal moves, stamped by the company's member. */
  async function version(c: Co, opts: { fy?: number; name?: string; kind?: string; status?: 'draft' | 'approved' | 'locked'; primary?: boolean } = {}, q: Q = pool): Promise<string> {
    const id = (await q.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [c.id, opts.fy ?? 2027, opts.name ?? `V-${crypto.randomUUID().slice(0, 8)}`, opts.kind ?? 'scenario', opts.primary ?? false, c.user])).rows[0].id as string;
    if (opts.status === 'approved' || opts.status === 'locked') await approve(c, id, q);
    if (opts.status === 'locked') await lock(c, id, q);
    return id;
  }
  const approve = (c: Co, id: string, q: Q = pool) => q.query(
    `UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [id, c.user]);
  const lock = (c: Co, id: string, q: Q = pool) => q.query(
    `UPDATE budget_versions SET status = 'locked', locked_by = $2, locked_at = now() WHERE id = $1`, [id, c.user]);
  const unlock = (c: Co, id: string, reason: string | null, q: Q = pool) => q.query(
    `UPDATE budget_versions SET status = 'approved', unlocked_by = $2, unlocked_at = now(), unlock_reason = $3 WHERE id = $1`,
    [id, c.user, reason]);

  /** One amount; `dims` names cc1/cc2/bu ids. */
  const amount = (c: Co, versionId: string, opts: { acct?: string; month?: string; amount?: number; cc1?: string | null; cc2?: string | null; bu?: string | null; company?: string } = {}, q: Q = pool) => q.query(
    `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [opts.company ?? c.id, versionId, opts.acct ?? c.acct, opts.month ?? '2026-03-01', opts.amount ?? 100,
      opts.cc1 ?? null, opts.cc2 ?? null, opts.bu ?? null]);

  /** A transaction as withAuth opens one: app_user, the member's claims, the active company. Rolled back unless `commit`. */
  async function asAppUser<T>(c: Co, fn: (q: PoolClient) => Promise<T>, commit = false): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: c.user })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c.id]);
      const out = await fn(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The SQLSTATE (and constraint) a statement fails with, or 'ok'. Runs in a savepoint so the session stays usable. */
  async function codeOf(q: PoolClient, text: string, params: unknown[] = []): Promise<string> {
    await q.query('SAVEPOINT bv_probe');
    try {
      await q.query(text, params);
      await q.query('RELEASE SAVEPOINT bv_probe');
      return 'ok';
    } catch (err) {
      await q.query('ROLLBACK TO SAVEPOINT bv_probe');
      const e = err as { code?: string; constraint?: string };
      return e.constraint ? `${e.code}:${e.constraint}` : String(e.code);
    }
  }

  return { A, B, setup, cleanup, version, approve, lock, unlock, amount, asAppUser, codeOf };
}
