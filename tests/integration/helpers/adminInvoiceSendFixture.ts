/**
 * Shared fixture for the WP7 admin invoice Send suites (admin-invoices-wp7-*.int.test.ts): one company with a
 * billing email on the reserved .test TLD, one super_admin, drafts written directly, and calls through the real
 * routes (withAdmin / withPlatformAdmin). Each suite mocks nodemailer itself (vi.mock is per file).
 */
import { expect } from 'vitest';
import { Pool } from 'pg';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import { signSession } from '../r-032-fake-gotrue.helpers';

export type Result = { status: number; body: { success: boolean; data?: Record<string, unknown>; error?: { message: string } } };
type Route = (req: never, res: never) => Promise<unknown>;

export function invoiceSendFixture(tag: string) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const admin = crypto.randomUUID();
  const company = crypto.randomUUID();
  const billing = `${tag}-${company.slice(0, 8)}@wp7.example.test`;
  let seq = 0;

  async function call(route: Route, body: unknown, id?: string, query?: Record<string, string>): Promise<Result> {
    const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
    const req = request(jar, body === undefined ? 'GET' : 'POST', id) as unknown as { body: unknown; query: Record<string, string> };
    if (body !== undefined) req.body = body;
    if (query) req.query = { ...req.query, ...query };
    const result = response();
    await route(req as never, result.res as never);
    return { status: result.state.statusCode, body: result.state.body as Result['body'] };
  }

  return {
    pool, admin, company, billing, call,
    async draft(): Promise<string> {
      seq += 1;
      return String((await pool.query(
        `INSERT INTO admin_invoices (company_id, invoice_number, status, subtotal_cents, tax_cents, total_cents, currency)
         VALUES ($1, $2, 'draft', 10000, 1500, 11500, 'ZAR') RETURNING id`, [company, `WP7${tag.slice(0, 2).toUpperCase()}-${company.slice(0, 5)}-${seq}`])).rows[0].id);
    },
    row: async (id: string) => (await pool.query('SELECT * FROM admin_invoices WHERE id=$1', [id])).rows[0],
    audits: async (id: string, action: string) =>
      (await pool.query('SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE target_id=$1 AND action=$2', [id, action])).rows[0].n as number,
    auditDetails: async (id: string, action: string) =>
      (await pool.query('SELECT details FROM admin_audit_log WHERE target_id=$1 AND action=$2', [id, action])).rows.map((r) => r.details),
    async setup() {
      await pool.query(`INSERT INTO companies (id, name, registration_number, billing_email, created_at) VALUES ($1, $2, $2, $3, NOW())`,
        [company, `WP7 ${tag} ${company}`, billing]);
      await pool.query(`INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'super_admin',true)`, [admin, `${admin}@test.local`]);
    },
    async teardown() {
      try {
        await pool.query('DELETE FROM email_log WHERE company_id=$1', [company]);
        await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [admin]);
        await pool.query('DELETE FROM admin_invoices WHERE company_id=$1', [company]);
        await pool.query('DELETE FROM users WHERE id=$1', [admin]);
        await pool.query('DELETE FROM companies WHERE id=$1', [company]);
        await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
      } finally {
        await pool.end();
      }
    },
    expectStatus(r: Result, status: number) { expect(r.status, JSON.stringify(r.body)).toBe(status); },
  };
}
