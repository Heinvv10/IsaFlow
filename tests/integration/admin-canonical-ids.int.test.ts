/**
 * PR #1405 breaker round 5 (WP14b): one spelling per id, through the real admin routes on the disposable fixture.
 *
 *   - (M) A UUID in an admin path is used in its canonical lower-case spelling: companies/[id]/impersonate with an
 *     upper-cased id minted its token and wrote its company.impersonate audit row under the UPPER spelling, and the
 *     company's audit view (entity_id matched exactly) never showed it. Same for companies/[id] PATCH (adminUuid)
 *     and invoices/[id]/mark-paid (AdminUuid, the zod form).
 *   - (L1) users.id is TEXT, so two rows can differ only in case. reset-password resolves the id once, an exact
 *     match first, and resets and audits that exact row: `lower(id) = lower($1) LIMIT 1` with no order could pick
 *     the other row, and the refusal check and the send could pick different rows.
 * sendEmail is mocked: no email leaves the test. Tokens are aal2.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const sendEmail = vi.hoisted(() => vi.fn(async (_opts: { to: string; html: string }) => ({ success: true })));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail }));

import impersonateCompany from '../../pages/api/admin/companies/[id]/impersonate';
import companyRoute from '../../pages/api/admin/companies/[id]';
import markPaidRoute from '../../pages/api/admin/billing/invoices/[id]/mark-paid';
import auditRoute from '../../pages/api/admin/audit';
import resetPassword from '../../pages/api/admin/users/[id]/reset-password';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const lowerUser = crypto.randomUUID();
const upperUser = lowerUser.toUpperCase();
const TAG = `wp14b-r6-${Date.now()}`;

type Body = { success?: boolean; data?: { token?: string; items?: Array<{ action?: string }> }; error?: { message?: string } };
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
const audits = async (action: string, target: string) => (await pool.query(
  'SELECT count(*)::int AS n FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 AND target_id = $3',
  [admin, action, target])).rows[0].n as number;
const jwtClaims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { company_id?: string };

beforeAll(async () => {
  vi.stubEnv('IMPERSONATION_JWT_SECRET', 'wp14d-synthetic-impersonation-signing-key-over-32');
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-r032-stash-encryption-key-over-32-characters');
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  // A case-variant pair: the lower-case row first, so an unordered pick finds it for the upper-case request too.
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [lowerUser, `${TAG}-lower@test.local`]);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [upperUser, `${TAG}-upper@test.local`]);
  await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2)`, [company, `${TAG} co`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')`, [company, admin]);
}, 60000);
beforeEach(async () => {
  sendEmail.mockClear();
  await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79' OR key LIKE $1", [`impersonate:${admin}%`]);
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM auth_password_reset_tokens WHERE user_id = $1::uuid', [lowerUser]);
    await pool.query('DELETE FROM admin_invoices WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [admin]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, lowerUser, upperUser]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79' OR key LIKE $1", [`impersonate:${admin}%`]);
  } finally {
    await pool.end();
    vi.unstubAllEnvs();
  }
});

describe('(M) a path UUID is used in its canonical lower-case spelling', () => {
  it('impersonate with an upper-cased company id: token and audit row under the lower-case id, shown in its audit view', async () => {
    const r = await call(impersonateCompany, 'POST', { id: company.toUpperCase() });
    expect(r.status).toBe(200);
    expect(jwtClaims(r.body.data!.token!).company_id).toBe(company);
    expect(await audits('company.impersonate', company)).toBe(1);
    expect(await audits('company.impersonate', company.toUpperCase())).toBe(0);
    const view = await call(auditRoute, 'GET', { entity_type: 'company', entity_id: company, source: 'admin' });
    expect(view.status).toBe(200);
    expect((view.body.data?.items ?? []).map((i) => i.action)).toContain('company.impersonate');
  });

  it('companies/[id] PATCH with an upper-cased id audits under the lower-case id', async () => {
    const r = await call(companyRoute, 'PATCH', { id: company.toUpperCase() }, { name: `${TAG} renamed` });
    expect(r.status).toBe(200);
    expect(await audits('company.update', company)).toBe(1);
    expect(await audits('company.update', company.toUpperCase())).toBe(0);
  });
});

describe('(M) the zod form, AdminUuid', () => {
  it('invoices/[id]/mark-paid with an upper-cased id: paid, audited under the lower-case id', async () => {
    const invoice = String((await pool.query(
      `INSERT INTO admin_invoices (company_id, invoice_number, status, subtotal_cents, tax_cents, total_cents, currency)
       VALUES ($1, $2, 'sent', 10000, 1500, 11500, 'ZAR') RETURNING id`, [company, `R6-${company.slice(0, 8)}`])).rows[0].id);
    const r = await call(markPaidRoute, 'POST', { id: invoice.toUpperCase() }, { payment_method: 'EFT' });
    expect(r.status).toBe(200);
    expect(await audits('invoice.mark_paid', invoice)).toBe(1);
    expect(await audits('invoice.mark_paid', invoice.toUpperCase())).toBe(0);
  });
});

describe('(L1) reset-password with two users whose ids differ only in case', () => {
  it.each([
    ['the upper-case id', upperUser, 'upper'],
    ['the lower-case id', lowerUser, 'lower'],
  ])('%s resets exactly that user: their email, their audit row', async (_name, id, which) => {
    const r = await call(resetPassword, 'POST', { id });
    expect(r.status).toBe(200);
    expect(sendEmail.mock.calls.map((c) => c[0].to)).toEqual([`${TAG}-${which}@test.local`]);
    expect(await audits('user.reset_password', id)).toBe(1);
  });
});
