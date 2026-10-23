/**
 * Shared fixture for the learning-loop integration suites (migrations 903 / 904): companies, members, a
 * bank GL account and an expense account per company, bank lines, and a request-scoped app_user
 * transaction exactly as withAuth opens one (always rolled back). Callers run assertDisposable() first.
 */
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

export interface Co { id: string; bank: string; expense: string; other: string }

export async function seedCompany(name: string): Promise<Co> {
  const co: Co = { id: crypto.randomUUID(), bank: crypto.randomUUID(), expense: crypto.randomUUID(), other: crypto.randomUUID() };
  await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [co.id, name]);
  await pool.query(
    `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
     VALUES ($1, $4, '1100', 'Bank', 'asset', 'bank', 'debit'),
            ($2, $4, '6100', 'Fuel', 'expense', NULL, 'debit'),
            ($3, $4, '6200', 'Telephone', 'expense', NULL, 'debit')`,
    [co.bank, co.expense, co.other, co.id]);
  return co;
}

export async function seedUser(companyIds: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO users(id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [id, `${id}@test.local`]);
  for (const c of companyIds) {
    await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'admin')", [c, id]);
  }
  return id;
}

export async function seedLine(co: Co, over: {
  date?: string; status?: string; runId?: string | null; ruleId?: string | null; createdAt?: string;
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, status,
                                    auto_post_run_id, allocation_rule_id, created_at)
     VALUES ($1, $2, $3, $4::DATE, -100, 'ENGEN FUEL', $5, $6, $7, COALESCE($8::TIMESTAMPTZ, now()))`,
    [id, co.id, co.bank, over.date ?? '2026-10-10', over.status ?? 'imported', over.runId ?? null, over.ruleId ?? null,
      over.createdAt ?? null]);
  return id;
}

/** A request-scoped transaction exactly as withAuth opens one; always rolled back. */
export async function asUser<T>(userId: string, activeCompany: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [activeCompany]);
    return await als.run({ client, userId, companyId: activeCompany, claims: {} } as never, () => fn(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** The pool role (BYPASSRLS on prod; superuser on the fixture) inside one rolled-back transaction, bound into ALS. */
export async function asPool<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await als.run({ client, claims: {} } as never, () => fn(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

export async function teardownCompanies(companyIds: string[], userIds: string[]): Promise<void> {
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM bank_auto_post_runs WHERE company_id = ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM bank_import_batches WHERE company_id = ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companyIds]);
  if (userIds.length > 0) await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds]);
}
