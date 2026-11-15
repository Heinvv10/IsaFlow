/**
 * PR #1405 breaker round 8 (WP14b), through the real admin routes on the disposable fixture.
 *
 *   - L1: rows about a company's subscription, invoice or webhook carry details.company_id, so the company's audit
 *     view (entity_type=company) lists them: subscription.update / .cancel, invoice.mark_paid, webhook.update / .delete.
 *   - L2: remove-from-company's orphan path re-checks, under the membership lock, that no users row exists. A user
 *     created between the route's look-up and that lock (forced here, as the breaker did) makes it a normal removal:
 *     audited under the stored id without orphan:true.
 *   - L3: two stored user ids that differ only in case, and a request naming neither exactly: 409 'Ambiguous user id'
 *     rather than acting on one of them.
 * Tokens are aal2. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

/** Runs `onOrphanLock` once, just before remove-from-company's orphan path locks the membership. */
const hook = vi.hoisted(() => ({ onOrphanLock: null as null | (() => Promise<void>) }));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  // Not async: a nested sql`` fragment must stay the fragment the real tag returns, not a promise of it.
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (hook.onOrphanLock && /^SELECT role FROM company_users WHERE user_id = \? AND company_id/.test(strings.join('?').trim())) {
      const run = hook.onOrphanLock;
      hook.onOrphanLock = null;
      return run().then(() => realSql(strings, ...values));
    }
    return realSql(strings, ...values);
  }, realSql);
  return { ...real, sql };
});

import auditRoute from '../../pages/api/admin/audit';
import subscriptionRoute from '../../pages/api/admin/billing/subscriptions/[id]';
import cancelRoute from '../../pages/api/admin/billing/subscriptions/[id]/cancel';
import markPaidRoute from '../../pages/api/admin/billing/invoices/[id]/mark-paid';
import webhookRoute from '../../pages/api/admin/webhooks/[id]';
import removeFromCompanyRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import activateRoute from '../../pages/api/admin/users/[id]/activate';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const TAG = `wp14b-r8-${Date.now()}`;

type Body = { data?: { items?: Array<{ action?: string }> }; error?: { message?: string } };
async function call(route: unknown, method: string, query: Record<string, string>, body: unknown = {}) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method) as unknown as { body: unknown; url: string; query: Record<string, string> };
  req.query = query;
  req.body = body;
  req.url = '/api/admin/x';
  const result = response();
  await (route as (q: never, s: never) => Promise<unknown>)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Body };
}
async function companyView(id: string): Promise<string[]> {
  const r = await call(auditRoute, 'GET', { source: 'admin', entity_type: 'company', entity_id: id, limit: '100' });
  expect(r.status).toBe(200);
  return (r.body.data?.items ?? []).map((i) => i.action ?? '');
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2)`, [company, `${TAG} co`]);
}, 60000);
beforeEach(async () => {
  hook.onOrphanLock = null;
  await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM webhook_endpoints WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM admin_invoices WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM subscriptions WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM plans WHERE code LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1 OR id ILIKE $2', [admin, `%${TAG}%`]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

describe('L1: subscription, invoice and webhook rows are in the company view', () => {
  it('subscription.update / .cancel, invoice.mark_paid, webhook.update / .delete', async () => {
    const plan = (await pool.query(`INSERT INTO plans (code, name, monthly_price_cents) VALUES ($1, 'p', 0) RETURNING id`, [`${TAG}-p`])).rows[0].id;
    const sub = (await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle) VALUES ($1, $2, 'active', 'monthly')
      RETURNING id`, [company, plan])).rows[0].id as string;
    const invoice = (await pool.query(`INSERT INTO admin_invoices (company_id, invoice_number, status, subtotal_cents, tax_cents, total_cents, currency)
      VALUES ($1, $2, 'sent', 100, 15, 115, 'ZAR') RETURNING id`, [company, `R8-${company.slice(0, 8)}`])).rows[0].id as string;
    const hook2 = crypto.randomUUID();
    await pool.query(`INSERT INTO webhook_endpoints (id, company_id, name, url, secret, events, is_active)
      VALUES ($1, $2, 'w', 'https://example.test/h', 's', ARRAY['invoice.created'], true)`, [hook2, company]);

    expect((await call(subscriptionRoute, 'PATCH', { id: sub }, { notes: 'r8' })).status).toBe(200);
    expect((await call(cancelRoute, 'POST', { id: sub }, { at_period_end: true })).status).toBe(200);
    expect((await call(markPaidRoute, 'POST', { id: invoice }, { payment_method: 'EFT' })).status).toBe(200);
    expect((await call(webhookRoute, 'PATCH', { id: hook2 }, { status: 'disabled' })).status).toBe(200);
    expect((await call(webhookRoute, 'DELETE', { id: hook2 })).status).toBe(200);

    expect(await companyView(company)).toEqual(expect.arrayContaining([
      'subscription.update', 'subscription.cancel', 'invoice.mark_paid', 'webhook.update', 'webhook.delete',
    ]));
  });
});

describe('subscriptions/[id] PATCH writes an audit row only for a real update (final round)', () => {
  const updates = async (id: string) => (await pool.query(`SELECT count(*)::int n FROM admin_audit_log
    WHERE admin_user_id = $1 AND action = 'subscription.update' AND target_id = $2`, [admin, id])).rows[0].n as number;

  it('an empty body is a 400, for a real subscription and a missing one; no audit row', async () => {
    const plan = (await pool.query(`INSERT INTO plans (code, name, monthly_price_cents) VALUES ($1, 'p', 0) RETURNING id`, [`${TAG}-p2`])).rows[0].id;
    const sub = (await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle) VALUES ($1, $2, 'active', 'monthly')
      RETURNING id`, [company, plan])).rows[0].id as string;
    const ghost = crypto.randomUUID();
    for (const id of [sub, ghost]) {
      const r = await call(subscriptionRoute, 'PATCH', { id }, {});
      expect(r.status).toBe(400);
      expect(r.body.error?.message).toMatch(/Nothing to update/);
      expect(await updates(id)).toBe(0);
    }
  });

  it('a non-empty body on a missing subscription is a 404; no audit row', async () => {
    const ghost = crypto.randomUUID();
    for (const body of [{ notes: 'x' }, { cancel_at_period_end: true }]) {
      expect((await call(subscriptionRoute, 'PATCH', { id: ghost }, body)).status).toBe(404);
    }
    expect(await updates(ghost)).toBe(0);
  });
});

describe('L2: a user created while the orphan path runs makes it a normal removal', () => {
  it('re-checked under the membership lock: removed, audited under the stored id without orphan:true', async () => {
    const id = `Late-${TAG}`;
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, id]);
    // The route has looked the user up (none) and is about to lock the membership: the user is created now.
    hook.onOrphanLock = async () => {
      await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${TAG}-late@test.local`]);
    };
    const r = await call(removeFromCompanyRoute, 'DELETE', { id }, { company_id: company });
    expect(r.status).toBe(200);
    expect(hook.onOrphanLock).toBeNull(); // the orphan path did run
    expect((await pool.query('SELECT 1 FROM company_users WHERE user_id = $1', [id])).rowCount).toBe(0);
    const audit = (await pool.query(`SELECT target_id, details FROM admin_audit_log WHERE admin_user_id = $1
      AND action = 'user.remove_from_company' AND target_id = $2`, [admin, id])).rows;
    expect(audit.map((a) => [a.target_id, a.details.orphan ?? null])).toEqual([[id, null]]);
  });
});

describe('L3: two stored ids that differ only in case', () => {
  it('a request naming neither exactly is 409 Ambiguous user id; naming one exactly acts on that one', async () => {
    const a = `Amb-${TAG}`;
    const b = a.toUpperCase();
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', false), ($3, $4, 'viewer', false)`,
      [a, `${TAG}-amb1@test.local`, b, `${TAG}-amb2@test.local`]);
    const neither = a.toLowerCase();
    const r = await call(activateRoute, 'POST', { id: neither });
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toMatch(/Ambiguous user id/);
    expect((await pool.query('SELECT count(*)::int n FROM users WHERE id = ANY($1) AND is_active', [[a, b]])).rows[0].n).toBe(0);

    expect((await call(activateRoute, 'POST', { id: b })).status).toBe(200);
    expect((await pool.query('SELECT id FROM users WHERE id = ANY($1) AND is_active', [[a, b]])).rows.map((x) => x.id)).toEqual([b]);
  });
});
