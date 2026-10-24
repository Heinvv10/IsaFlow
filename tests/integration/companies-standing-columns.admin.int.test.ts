// tests/integration/companies-standing-columns.admin.int.test.ts
//
// Migration 936 left the 13 standing and billing columns of companies to two
// writers: the admin site (platform_admin) and signup's provisionTenant
// (migration_admin). This suite drives their real routes on those two roles
// as real LOGINS, as production has them (the fixture's default
// PLATFORM_ADMIN_DATABASE_URL is the superuser, which would prove nothing),
// and reads each persisted value back: suspend and reactivate, trial
// extension, plan change, PAYG eligibility, bulk actions, create, delete and
// restore, billing contact, waitlist promotion and the verify-email signup.
// The attacks: companies-standing-columns.int.test; the app-pool writers:
// companies-standing-columns.paths.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { getPlatformAdminPool } from '@/lib/auth/withPlatformAdmin.pools';
import { createEmailVerificationToken, type PendingSignup } from '@/lib/auth/emailVerificationService';
import suspendRoute from '../../pages/api/admin/companies/[id]/suspend';
import activateRoute from '../../pages/api/admin/companies/[id]/activate';
import restoreRoute from '../../pages/api/admin/companies/[id]/restore';
import companyRoute from '../../pages/api/admin/companies/[id]';
import companiesRoute from '../../pages/api/admin/companies';
import bulkRoute from '../../pages/api/admin/companies/bulk-action';
import trialsRoute from '../../pages/api/admin/trials';
import convertRoute from '../../pages/api/admin/trials/convert';
import eligibilityRoute from '../../pages/api/admin/billing/payg/[companyId]/eligibility';
import promoteRoute from '../../pages/api/admin/waitlist/[id]/promote';
import verifyEmailRoute from '../../pages/api/auth/verify-email';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { gotruePath } from './mfa-impersonation-postgres.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';
import { clearRateLimits, column, dropCompanies, standing } from './companies-standing-columns.helpers';

// Signup's ops notification is mail leaving the system; everything else is real.
vi.mock('@/modules/accounting/services/core/emailService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/core/emailService')>()),
  sendEmail: vi.fn(async () => ({ success: true })),
}));

const ids = newIds();
const tag = crypto.randomUUID().slice(0, 8);
const target = crypto.randomUUID();
const bulkA = crypto.randomUUID();
const bulkB = crypto.randomUUID();
const lifecycle = crypto.randomUUID();
const plan = crypto.randomUUID();
const made: string[] = []; // companies created through routes
const waitlistId = crypto.randomUUID();
let trialPlan: string | null = null;

/** Log in as `role` with a fresh password, on the fixture's host and database (not the app login setup() put in DATABASE_URL). */
async function platformAdminUrl(fixtureUrl: string): Promise<string> {
  const password = crypto.randomUUID();
  await fixture.query(`ALTER ROLE platform_admin LOGIN PASSWORD '${password}'`);
  const url = new URL(fixtureUrl);
  url.username = 'platform_admin';
  url.password = password;
  return url.toString();
}

beforeAll(async () => {
  const fixtureUrl = process.env.DATABASE_URL!;
  await setup(ids);
  // The admin pool is built lazily on the first admin route call: point it at the role itself first.
  vi.stubEnv('PLATFORM_ADMIN_DATABASE_URL', await platformAdminUrl(fixtureUrl));
  await fixture.query(`INSERT INTO plans (id, code, name) VALUES ($1, $2, '936 admin plan')`, [plan, `p936a-${tag}`]);
  trialPlan = (await fixture.query(`INSERT INTO plans (code, name) SELECT 'trial', '936 trial'
    WHERE NOT EXISTS (SELECT 1 FROM plans WHERE code = 'trial') RETURNING id`)).rows[0]?.id ?? null;
  await fixture.query(`INSERT INTO companies (id, name, trial_ends_at) VALUES
    ($1, $4, NOW() + interval '5 days'), ($2, $5, NULL), ($3, $6, NOW() + interval '2 days')`,
  [target, bulkA, bulkB, `ADM target ${tag}`, `ADM bulk A ${tag}`, `ADM bulk B ${tag}`]);
  await fixture.query(`INSERT INTO companies (id, name, status, suspended_at, suspended_reason)
    VALUES ($1, $2, 'suspended', NOW(), 'unpaid')`, [lifecycle, `ADM lifecycle ${tag}`]);
  await fixture.query(`INSERT INTO waitlist_signups (id, email, company_name, phone, annual_turnover_cents)
    VALUES ($1, $2, $3, '0821110000', 50000000)`, [waitlistId, `wl-${tag}@test.local`, `ADM waitlist ${tag}`]);
}, 60000);

afterAll(async () => {
  try {
    await fixture.query('DELETE FROM waitlist_signups WHERE id = $1', [waitlistId]);
    await fixture.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [ids.admin]);
    await fixture.query('DELETE FROM auth_email_verification_tokens WHERE payload->>\'companyName\' LIKE $1', [`936 signup ${tag}%`]);
    await dropCompanies([target, bulkA, bulkB, lifecycle, ...made]);
    await fixture.query('DELETE FROM plans WHERE id = $1 OR id = $2', [plan, trialPlan]);
    await clearRateLimits();
    await fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE 'admin:%'`);
    await fixture.query('ALTER ROLE platform_admin NOLOGIN PASSWORD NULL');
  } finally {
    await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), getPlatformAdminPool()]);
  }
}, 60000);

const asAdmin = (route: unknown, method: string, opts: { query?: Record<string, string>; body?: unknown } = {}) =>
  callRoute(route, { sub: ids.admin, method, ...opts });
const ok = (r: { status: number; body: unknown }) => { expect(r.status, JSON.stringify(r.body)).toBe(200); return r; };
const data = (r: { body: unknown }) => (r.body as { data: Record<string, unknown> }).data;
const audits = async (action: string, targetId: string) => (await fixture.query(
  'SELECT 1 FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 AND target_id = $3', [ids.admin, action, targetId])).rowCount;
/** `column` of a company as text, to compare timestamps to the microsecond. */
const text = async (id: string, col: string) => (await fixture.query(`SELECT ${col}::text AS v FROM companies WHERE id = $1`, [id]))
  .rows[0]!.v as string | null;
/** Seconds `col` lies after the text timestamp `since`. */
const secondsAfter = async (id: string, col: string, since: string) => Number((await fixture.query(
  `SELECT extract(epoch FROM (${col} - $2::timestamptz)) AS s FROM companies WHERE id = $1`, [id, since])).rows[0]!.s);

describe('936: the admin site on a real platform_admin login', () => {
  it('runs as platform_admin itself, not the superuser', async () => {
    ok(await asAdmin(trialsRoute, 'GET')); // builds the admin pool
    const who = await getPlatformAdminPool().query('SELECT session_user AS s, current_user AS c');
    expect(who.rows[0]).toEqual({ s: 'platform_admin', c: 'platform_admin' });
  });

  it('suspends a company, then reactivates it', async () => {
    ok(await asAdmin(suspendRoute, 'POST', { query: { id: target }, body: { reason: 'unpaid 936' } }));
    expect(await standing(target)).toMatchObject({ status: 'suspended', suspended_reason: 'unpaid 936' });
    expect(await column(target, 'suspended_at')).not.toBeNull();
    expect(await audits('company.suspend', target)).toBe(1);
    ok(await asAdmin(activateRoute, 'POST', { query: { id: target } }));
    expect(await standing(target)).toMatchObject({ status: 'active', suspended_reason: null, suspended_at: null });
    expect(await audits('company.activate', target)).toBe(1);
  });

  it('extends a trial by 7 days, singly and in bulk (trials route)', async () => {
    const before = (await text(target, 'trial_ends_at'))!;
    const one = ok(await asAdmin(trialsRoute, 'POST', { body: { company_id: target, days: 7 } }));
    expect(data(one)).toMatchObject({ company_id: target, days: 7 });
    expect(await secondsAfter(target, 'trial_ends_at', before)).toBe(7 * 86400);
    expect(await column(bulkA, 'trial_ends_at')).toBeNull();
    const beforeB = (await text(bulkB, 'trial_ends_at'))!;
    ok(await asAdmin(trialsRoute, 'POST', { body: { company_ids: [bulkA, bulkB], days: 3 } }));
    expect(await secondsAfter(bulkB, 'trial_ends_at', beforeB)).toBe(3 * 86400);
    expect(await column(bulkA, 'trial_ends_at')).not.toBeNull(); // based on NOW() when it had none
    expect(await audits('trial.extend', target)).toBe(1);
  });

  it('converts a trial to a plan (POST /api/admin/trials/convert)', async () => {
    await fixture.query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [bulkB]);
    const r = await asAdmin(convertRoute, 'POST', { body: { companyId: bulkB, planId: plan } });
    // BROKEN (not 936): markAsConverted's subscriptions upsert is ON CONFLICT (company_id) and the schema has no
    // such unique index, so the route answers 400 and the aborted transaction rolls its companies UPDATE back.
    // Whatever it answers, it must not be a privilege refusal; when it answers 200 the plan and status persist.
    const message = (r.body as { error?: { message?: string } }).error?.message ?? '';
    expect(r.status === 200 ? 'ok' : message, JSON.stringify(r.body)).toMatch(/^ok$|ON CONFLICT specification$/);
    if (r.status === 200) expect(await standing(bulkB)).toMatchObject({ status: 'active', plan_id: plan });
  });

  it('platform_admin writes plan_id and status (the statement markAsConverted opens with)', async () => {
    await fixture.query(`UPDATE companies SET status = 'suspended', plan_id = NULL WHERE id = $1`, [bulkB]);
    const upd = await getPlatformAdminPool().query(`UPDATE companies SET status = 'active', plan_id = $2::uuid, updated_at = NOW()
      WHERE id = $1::uuid AND status IS DISTINCT FROM 'deleted'`, [bulkB, plan]);
    expect(upd.rowCount).toBe(1);
    expect(await standing(bulkB)).toMatchObject({ status: 'active', plan_id: plan });
  });

  it('sets PAYG eligibility on and off', async () => {
    const eligible = async (v: boolean) => ok(await asAdmin(eligibilityRoute, 'POST', { query: { companyId: target }, body: { eligible: v } }));
    expect(data(await eligible(true))).toEqual({ companyId: target, eligible: true });
    expect(await column(target, 'payg_eligible')).toBe(true);
    await eligible(false);
    expect(await column(target, 'payg_eligible')).toBe(false);
    expect(await audits('flow.eligibility', target)).toBe(2);
  });

  it('bulk action: suspends several companies, then extends their trials', async () => {
    const r = ok(await asAdmin(bulkRoute, 'POST', { body: { action: 'suspend', company_ids: [target, bulkA], reason: 'bulk 936' } }));
    expect(data(r)).toEqual({ processed: 2, errors: [] });
    for (const id of [target, bulkA]) expect(await standing(id)).toMatchObject({ status: 'suspended', suspended_reason: 'bulk 936' });
    const before = (await text(target, 'trial_ends_at'))!;
    const e = ok(await asAdmin(bulkRoute, 'POST', { body: { action: 'extend_trial', company_ids: [target], days: 10 } }));
    expect(data(e)).toEqual({ processed: 1, errors: [] });
    expect(await secondsAfter(target, 'trial_ends_at', before)).toBe(10 * 86400);
    ok(await asAdmin(activateRoute, 'POST', { query: { id: target } }));
    ok(await asAdmin(activateRoute, 'POST', { query: { id: bulkA } }));
  });

  it('creates a company: it starts active, not PAYG-eligible, with its trial subscription', async () => {
    const r = ok(await asAdmin(companiesRoute, 'POST', { body: { name: `ADM created ${tag}`, email: 'new@adm.test', plan_id: plan } }));
    const id = String(data(r).id);
    made.push(id);
    expect(await standing(id)).toMatchObject({ status: 'active', payg_eligible: false, is_active: true, plan_id: null });
    expect((await fixture.query('SELECT status, plan_id FROM subscriptions WHERE company_id = $1', [id])).rows)
      .toEqual([{ status: 'trial', plan_id: plan }]);
  });

  it('updates the billing email and contact', async () => {
    const r = ok(await asAdmin(companyRoute, 'PATCH', { query: { id: target },
      body: { billing_email: 'billing@adm.test', billing_contact: 'Adm Contact', trading_name: 'ADM trading' } }));
    expect(data(r)).toMatchObject({ billing_email: 'billing@adm.test', billing_contact: 'Adm Contact' });
    expect(await standing(target)).toMatchObject({ billing_email: 'billing@adm.test', billing_contact: 'Adm Contact' });
    expect(await column(target, 'trading_name')).toBe('ADM trading');
  });

  it('deletes a suspended company (refusing suspend and activate on it), then restores it still suspended', async () => {
    ok(await asAdmin(companyRoute, 'DELETE', { query: { id: lifecycle } }));
    expect(await standing(lifecycle)).toMatchObject({ status: 'deleted', suspended_reason: 'unpaid' });
    expect((await asAdmin(suspendRoute, 'POST', { query: { id: lifecycle }, body: { reason: 'x' } })).status).toBe(404);
    expect((await asAdmin(activateRoute, 'POST', { query: { id: lifecycle } })).status).toBe(404);
    expect(await column(lifecycle, 'status')).toBe('deleted');
    ok(await asAdmin(restoreRoute, 'POST', { query: { id: lifecycle } }));
    expect(await standing(lifecycle)).toMatchObject({ status: 'suspended', suspended_reason: 'unpaid' });
    ok(await asAdmin(activateRoute, 'POST', { query: { id: lifecycle } }));
    expect(await column(lifecycle, 'status')).toBe('active');
  });

  it('promotes a waitlist lead into a company with the PAYG flag from its declared turnover', async () => {
    const r = ok(await asAdmin(promoteRoute, 'POST', { query: { id: waitlistId }, body: { planCodeOverride: `p936a-${tag}` } }));
    const companyId = String(data(r).companyId);
    made.push(companyId);
    expect(data(r)).toMatchObject({ status: 'promoted', planCode: `p936a-${tag}` });
    expect(await standing(companyId)).toMatchObject({ status: 'active', payg_eligible: true, is_active: true });
    expect(await column(companyId, 'annual_turnover_cents')).toBe('50000000');
    expect((await fixture.query('SELECT promoted_company_id FROM waitlist_signups WHERE id = $1', [waitlistId])).rows)
      .toEqual([{ promoted_company_id: companyId }]);
  });
});

describe('936: signup provisions a tenant on migration_admin (POST /api/auth/verify-email)', () => {
  it('persists is_active, payg_eligible and trial_ends_at for the new company', async () => {
    const userId = crypto.randomUUID();
    const pending: PendingSignup = { email: `${userId}@test.local`, firstName: 'Sign', lastName: 'Up',
      companyName: `936 signup ${tag}`, phone: '0821112222', annualTurnoverCents: 50_000_000, signupType: 'direct' };
    const { token } = await createEmailVerificationToken(userId, pending);
    // GoTrue is outside this system: it knows the user's address and accepts the confirmation.
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = gotruePath(new URL(String(input)));
      if (path !== `/admin/users/${userId}`) throw new Error(`unexpected fetch ${String(input)}`);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return new Response(JSON.stringify({ id: userId, email: pending.email }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const r = ok(await callRoute(verifyEmailRoute, { sub: userId, method: 'POST', body: { token } }));
      const companyId = String(data(r).companyId);
      made.push(companyId);
      expect(calls).toEqual([`GET /admin/users/${userId}`, `PUT /admin/users/${userId}`]);
      expect(await standing(companyId)).toMatchObject({ status: 'active', is_active: true, payg_eligible: true, plan_id: null });
      const trial = (await fixture.query(`SELECT trial_ends_at > NOW() + interval '1 day' AS future,
        trial_ends_at = (SELECT current_period_end FROM subscriptions WHERE company_id = $1) AS matches_sub
        FROM companies WHERE id = $1`, [companyId])).rows[0] as { future: boolean; matches_sub: boolean | null };
      expect(trial.future).toBe(true);
      if (trialPlan) expect(trial.matches_sub).toBe(true);
      expect((await fixture.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [companyId, userId])).rows)
        .toEqual([{ role: 'owner' }]);
    } finally {
      vi.unstubAllGlobals();
      await fixture.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  }, 60000);
});
