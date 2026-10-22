// tests/integration/s07b-app-pool-login-role.paths.int.test.ts
//
// Audit 2026-10-18 S-07b: every kind of legitimate path still works when the
// app's pools log in as production will have them (migrations 915, 916):
// DATABASE_URL as isaflow_app, SERVICE_DATABASE_URL as isaflow_service,
// MIGRATION_ADMIN_DATABASE_URL as migration_admin. Each runs through its real
// route or service. The attacks: s07b-app-pool-login-role.int.test.ts.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import profileRoute from '../../pages/api/auth/profile';
import meRoute from '../../pages/api/auth/me';
import dsrRoute from '../../pages/api/accounting/data-subject-rights';
import changeEmailRoute from '../../pages/api/auth/change-email';
import inviteRoute from '../../pages/api/invite/[token]';
import adminSettingsRoute from '../../pages/api/admin/settings';
import mcpRoute from '../../pages/api/mcp/index';
import resetFlowMonthRoute from '../../pages/api/cron/reset-flow-month';
import matviewRoute from '../../pages/api/cron/ar-matview-refresh';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { checkRateLimit } from '@/lib/rateLimit';
import { createEmailVerificationToken } from '@/lib/auth/emailVerificationService';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { runAuditTx } from '@/modules/accounting/services/audit/auditTx';
import { readDefaultAccountMappings } from '@/modules/accounting/services/gl/defaultAccountsService';
import { callRoute, inServiceContext, userRow } from './s07-users-privilege-columns.helpers';
import { response } from './mfa-impersonation-postgres.helpers';
import { CRON, callCron, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const { me, admin, invitee, company, other, inviteToken, pat } = ids;

beforeAll(() => setup(ids), 60000);
afterAll(() => teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]));

describe('S-07b: every kind of legitimate path still works on the new logins', () => {
  it('withAuth (isaflow_app -> app_user): profile PUT writes names', async () => {
    const r = await callRoute(profileRoute, { sub: me, method: 'PUT', companyId: company, body: { firstName: 'After', lastName: 'After' } });
    expect(r.status).toBe(200);
    expect(await userRow(me)).toMatchObject({ first_name: 'After' });
  });

  it('withUserAuth (service): me lists the caller\'s company', async () => {
    const r = await callRoute(meRoute, { sub: me, method: 'GET' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain(company);
  });

  it('withUserAuth: invite/[token] POST (migration_admin pool) adds the invitee to a company it is not yet in', async () => {
    const r = await callRoute(inviteRoute, { sub: invitee, method: 'POST', query: { token: inviteToken } });
    expect(r.status).toBe(200);
    const m = await fixture.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, invitee]);
    expect(m.rows).toEqual([{ role: 'viewer' }]);
    const inv = await fixture.query('SELECT accepted_at FROM company_invitations WHERE company_id = $1', [company]);
    expect(inv.rows[0].accepted_at).not.toBeNull();
    expect((await userRow(invitee)).onboarding_completed).toBe(true);
  });

  it('withUserAuth (service): change-email writes users.email', async () => {
    // Every suite's route calls share one client IP; another suite's calls must not spend this one's limit.
    await fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE '%change-email%'`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'x', id: invitee }), {
      status: 200, headers: { 'content-type': 'application/json' } })));
    const r = await callRoute(changeEmailRoute, { sub: invitee, method: 'POST',
      body: { newEmail: `${invitee}-new@test.local`, currentPassword: 'pw' } });
    vi.unstubAllGlobals();
    expect(r.status).toBe(200);
    expect((await userRow(invitee)).email).toBe(`${invitee}-new@test.local`);
  });

  it('withAuth + service pool: the POPIA erasure anonymises names and email', async () => {
    const r = await callRoute(dsrRoute, { sub: me, method: 'POST', companyId: company, body: { action: 'erasure' } });
    expect(r.status).toBe(200);
    expect(await userRow(me)).toMatchObject({ first_name: 'Anonymized', email: `anonymized_${me.slice(0, 8)}@deleted.invalid` });
  });

  it('withPlatformAdmin (gate on isaflow_app): a super_admin reads admin settings', async () => {
    const r = await callRoute(adminSettingsRoute, { sub: admin, method: 'GET' });
    expect(r.status).toBe(200);
  });

  it('bearer (PAT looked up on service, request on isaflow_app): MCP answers ping', async () => {
    const result = response();
    const req = { method: 'POST', url: '/api/mcp', headers: { authorization: `Bearer ${pat}` }, cookies: {}, query: {},
      body: { jsonrpc: '2.0', id: 1, method: 'ping' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as NextApiRequest;
    await (mcpRoute as (a: never, b: never) => Promise<unknown>)(req as never, result.res as never);
    expect({ status: result.state.statusCode, body: result.state.body }).toMatchObject({ status: 200, body: { id: 1, result: {} } });
  });

  it('cron (service): reset-flow-month resets every tenant\'s wallet', async () => {
    const r = await callCron(resetFlowMonthRoute, CRON);
    expect(r.status).toBe(200);
    const w = await fixture.query('SELECT month_flows_used FROM flow_wallet WHERE company_id = ANY($1)', [[company, other]]);
    expect(w.rows).toEqual([{ month_flows_used: 0 }, { month_flows_used: 0 }]);
  });

  it('cron (service): ar-matview-refresh refreshes the view through the definer wrapper', async () => {
    expect((await callCron(matviewRoute, CRON)).status).toBe(200);
  });

  it('rate limit (service rate-limit pool) charges a counter', async () => {
    const key = `s07b:${crypto.randomUUID()}`;
    expect(await checkRateLimit(key, { max: 5, windowSecs: 60 })).toBe(true);
    expect((await fixture.query('SELECT count(*)::int AS n FROM rate_limit_counters WHERE key = $1', [key])).rows[0].n).toBe(1);
  });

  it('email verification (service; table granted to app_service only) issues a token', async () => {
    const { token } = await createEmailVerificationToken(admin, { email: `${admin}@test.local`, firstName: 'A', lastName: 'B',
      companyName: 'S07b', phone: null, annualTurnoverCents: null, signupType: 'direct' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('app_settings under security_invoker (916): app_user still reads its own company\'s settings', async () => {
    await fixture.query(`INSERT INTO accounting_settings (company_id, key, value) VALUES ($1, 'accounting_default_accounts', '{"s07b":"mine"}')`, [company]);
    let mappings: Record<string, unknown> = {};
    await inServiceContext('app_user', me, async () => { mappings = await readDefaultAccountMappings(company); });
    expect(mappings).toMatchObject({ s07b: 'mine' });
  });

  it('runAuditTx (service pool, then SET LOCAL ROLE app_user) runs as app_user', async () => {
    const who = await runAuditTx({ userId: me, companyId: company, claims: { sub: me } }, 'READ COMMITTED',
      async (c) => (await c.query('SELECT current_user AS u')).rows[0].u as string);
    expect(who).toBe('app_user');
  });
});
