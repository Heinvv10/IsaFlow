// tests/integration/r168-practice-crons.helpers.ts
//
// Shared seed for the R-168 practice cron suites. The crons run as the pool's
// own role (no withAuth, no RLS), so the suites seed and read as that role too.

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface Standing { active?: boolean; status?: string | null; suspended?: boolean }

/** One company per standing the crons must honour, plus the two live ones. */
export function fixtureCompanies() {
  return { A: randomUUID(), B: randomUUID(), DELETED: randomUUID(), SUSPENDED: randomUUID(), SUSPENDED_AT: randomUUID() };
}

export async function seedCompanies(pool: Pool, tag: string, c: ReturnType<typeof fixtureCompanies>, extra: string[] = []) {
  await pool.query(
    `INSERT INTO companies (id, name, is_active, status, suspended_at) VALUES
       ($1, $6 || ' Co A', true, 'active', NULL), ($2, $6 || ' Co B', true, 'active', NULL),
       ($3, $6 || ' Co deleted', true, 'deleted', NULL), ($4, $6 || ' Co suspended', true, 'suspended', NULL),
       ($5, $6 || ' Co suspended_at', true, 'active', NOW())`,
    [c.A, c.B, c.DELETED, c.SUSPENDED, c.SUSPENDED_AT, tag]);
  for (const id of extra) {
    await pool.query("INSERT INTO companies (id, name, is_active, status) VALUES ($1, $2, true, 'active')", [id, `${tag} Co ${id}`]);
  }
}

/** A user, member of each company in `companies`, with the given account standing. */
export async function seedUser(
  pool: Pool, id: string, email: string, companies: string[], firstName: string, s: Standing = {},
) {
  await pool.query(
    `INSERT INTO users (id, email, first_name, role, is_active, status, suspended_at)
     VALUES ($1, $2, $3, 'admin', $4, $5, CASE WHEN $6 THEN NOW() END)`,
    [id, email, firstName, s.active ?? true, s.status === undefined ? 'active' : s.status, s.suspended ?? false]);
  for (const company of companies) {
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [company, id]);
  }
}

export async function cleanup(pool: Pool, companies: string[], users: string[], tables: string[]) {
  for (const t of [...tables, 'company_users']) {
    await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companies]);
  }
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
}

export function cronRequest(url: string, key: string, body: unknown = {}) {
  return { method: 'POST', url, query: {}, cookies: {}, body,
    headers: { 'x-cron-secret': key }, socket: { remoteAddress: '127.0.0.168' } };
}
