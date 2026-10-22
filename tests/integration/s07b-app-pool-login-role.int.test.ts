// tests/integration/s07b-app-pool-login-role.int.test.ts
//
// Audit 2026-10-18 S-07b: the app's pools must not log in as the owner.
//
// Every pool built from DATABASE_URL logged in as `postgres`, which owns users
// and bypasses RLS. withAuth's `SET LOCAL ROLE app_user` is undone by injected
// set_config('role','none',true) or RESET ROLE: the session user comes back,
// and the owner can set users.role = 'super_admin' or read any tenant.
// Migration 910 gives the request pools isaflow_app (NOINHERIT, member of
// app_user only) and the no-transaction paths isaflow_service (app_service).
//
// Each attack runs on the pool the app itself builds (getAuthPool, getDbPool)
// from the env production will have, logged in for real. Each must be refused
// with 42501 and the message that says WHY, so an RLS refusal or a failed SET
// ROLE cannot pass for one another. Then every kind of legitimate path runs
// through its real route or service on the same pools.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { NextApiRequest } from 'next';
import type { Pool } from 'pg';
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
import { runAuditTx } from '@/modules/accounting/services/audit/auditTx';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import { pool as fixture, callRoute, userRow } from './s07-users-privilege-columns.helpers';
import { response } from './mfa-impersonation-postgres.helpers';
import { attempt, callCron, lastDoBlock, loginUrl } from './s07b-app-pool-login-role.helpers';

const MIGRATION = readFileSync(join(process.cwd(), 'scripts/migrations/sql/910_app_pool_login_roles.sql'), 'utf8');
const CRON = 's07b-cron-secret-0123456789abcdef0123456789';
const me = crypto.randomUUID();
const admin = crypto.randomUUID();
const invitee = crypto.randomUUID();
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const otherJournal = crypto.randomUUID();
const inviteToken = `s07b-${crypto.randomUUID()}`;
const pat = `pat_${crypto.randomUUID().replace(/-/g, '')}`;
/** The MCP connector flag, when this suite had to create it (the baseline holds no data). */
let mcpFlag: string | null = null;

beforeAll(async () => {
  const fixtureUrl = process.env.DATABASE_URL!;
  vi.stubEnv('DATABASE_URL', await loginUrl(fixture, fixtureUrl, 'isaflow_app'));
  vi.stubEnv('SERVICE_DATABASE_URL', await loginUrl(fixture, fixtureUrl, 'isaflow_service'));
  vi.stubEnv('CRON_SECRET', CRON);
  vi.stubEnv('SUPABASE_ANON_KEY', 'x');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'x');
  for (const [id, name] of [[company, 'S07b mine'], [other, 'S07b other tenant']]) {
    await fixture.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [id, name]);
    await fixture.query(`INSERT INTO flow_wallet (company_id, month_flows_used) VALUES ($1, 7)`, [id]);
  }
  for (const [id, role] of [[me, 'viewer'], [admin, 'super_admin'], [invitee, 'viewer']]) {
    await fixture.query(`INSERT INTO users (id, email, first_name, last_name, role, is_active, status)
      VALUES ($1, $2, 'Before', 'Before', $3, true, 'active')`, [id, `${id}@test.local`, role]);
  }
  await fixture.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true)`, [company, me]);
  await fixture.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, created_by)
    VALUES ($1, $2, 'S07B-1', '2026-01-01', 'other tenant', 'draft', 'manual', $3)`, [otherJournal, other, admin]);
  await fixture.query(`INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
    VALUES ($1, $2, 'viewer', $3, $4, NOW() + interval '1 day')`, [company, `${invitee}@test.local`, me, hashInviteToken(inviteToken)]);
  await fixture.query(`INSERT INTO personal_access_tokens (user_id, company_id, token_hash, token_prefix, name, scopes, expires_at)
    VALUES ($1, $2, $3, $4, 's07b', '{read:reports}', NOW() + interval '1 day')`,
  [me, company, createHash('sha256').update(pat).digest('hex'), pat.slice(0, 12)]);
  const flag = await fixture.query(`INSERT INTO feature_flags (code, name) SELECT 'mcp_connector', 'MCP connector'
    WHERE NOT EXISTS (SELECT 1 FROM feature_flags WHERE code = 'mcp_connector') RETURNING id`);
  mcpFlag = (flag.rows[0]?.id as string | undefined) ?? null;
  await fixture.query(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
    SELECT $1, id, true, $2 FROM feature_flags WHERE code = 'mcp_connector'`, [company, admin]);
}, 60000);

afterAll(async () => {
  try {
    for (const t of ['company_feature_overrides', 'personal_access_tokens', 'company_invitations', 'company_users', 'gl_journal_entries', 'flow_wallet']) {
      await fixture.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[company, other]]);
    }
    await fixture.query('DELETE FROM auth_email_verification_tokens WHERE gotrue_user_id = ANY($1)', [[me, admin, invitee]]);
    await fixture.query('DELETE FROM users WHERE id = ANY($1)', [[me, admin, invitee]]);
    await fixture.query('DELETE FROM companies WHERE id = ANY($1)', [[company, other]]);
    if (mcpFlag) await fixture.query('DELETE FROM feature_flags WHERE id = $1', [mcpFlag]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await Promise.all([getAuthPool().end(), getDbPool().end(), fixture.end()]);
  }
});

const asMe = { asRequest: { sub: me, companyId: company } };
const ownerWrite: [string, unknown[]] = [`UPDATE users SET role = 'super_admin' WHERE id = $1`, [me]];
const otherTenantRead: [string, unknown[]] = ['SELECT name FROM companies WHERE id = $1', [other]];
const otherJournalRead: [string, unknown[]] = ['SELECT description FROM gl_journal_entries WHERE id = $1', [otherJournal]];

describe('S-07b: the request pool cannot get back to the owner', () => {
  const pool = (): Pool => getAuthPool();

  it('logs in as isaflow_app, which bypasses no RLS and owns nothing', async () => {
    const r = await pool().query(`SELECT session_user AS s, r.rolbypassrls AS b, r.rolinherit AS i
      FROM pg_roles r WHERE r.rolname = session_user`);
    expect(r.rows[0]).toEqual({ s: 'isaflow_app', b: false, i: false });
  });

  it.each([
    ['set_config(role, none)', `SELECT set_config('role', 'none', true)`],
    ['RESET ROLE', 'RESET ROLE'],
  ])('after %s, the owner write and other tenants\' rows are refused outright', async (_, escape) => {
    for (const probe of [ownerWrite, otherTenantRead, otherJournalRead]) {
      expect(await attempt(pool(), [[escape], probe], asMe))
        .toMatchObject({ code: '42501', message: expect.stringMatching(/^permission denied for table (users|companies|gl_journal_entries)$/) });
    }
  });

  it('a single statement that drops the role cannot read as the owner', async () => {
    expect(await attempt(pool(), [[`SELECT set_config('role', 'none', true),
      query_to_xml(format('SELECT name FROM companies WHERE id = %L', $1::text), true, false, '')`, [other]]], asMe))
      .toMatchObject({ code: '42501', message: 'permission denied for table companies' });
  });

  it.each([
    ['SET ROLE postgres', 'SET ROLE postgres', /permission denied to set role "postgres"/],
    ['set_config(role, postgres)', `SELECT set_config('role', 'postgres', true)`, /permission denied to set role "postgres"/],
    ['SET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION postgres', /permission denied to set session authorization/],
    ['SET ROLE migration_admin', 'SET ROLE migration_admin', /permission denied to set role/],
    ['SET ROLE platform_admin', 'SET ROLE platform_admin', /permission denied to set role/],
    ['SET ROLE app_service', 'SET ROLE app_service', /permission denied to set role/],
    ['SET ROLE isaflow_service', 'SET ROLE isaflow_service', /permission denied to set role/],
  ])('%s is refused', async (_, stmt, msg) => {
    expect(await attempt(pool(), [[stmt]], asMe)).toMatchObject({ code: '42501', message: expect.stringMatching(msg) });
  });
});

describe('S-07b: the service pool cannot get to the owner either', () => {
  const pool = (): Pool => getDbPool();

  it('logs in as isaflow_service; RESET ROLE stays there', async () => {
    expect(await attempt(pool(), [['RESET ROLE'], [`DO $$ BEGIN IF current_user <> 'isaflow_service' OR session_user <> 'isaflow_service'
      THEN RAISE EXCEPTION 'landed on %', current_user; END IF; END $$`]])).toBeNull();
  });

  it.each([
    ['writes users.role', ownerWrite, /^permission denied for table users$/],
    ['disables triggers', ['ALTER TABLE users DISABLE TRIGGER ALL', []], /^must be owner of table users$/],
    ['writes the forensic change log', ['DELETE FROM entity_changes', []], /^permission denied for table entity_changes$/],
    ['SET ROLE postgres', ['SET ROLE postgres', []], /permission denied to set role "postgres"/],
    ['SET ROLE migration_admin', ['SET ROLE migration_admin', []], /permission denied to set role/],
    ['SET ROLE platform_admin', ['SET ROLE platform_admin', []], /permission denied to set role/],
  ] as Array<[string, [string, unknown[]], RegExp]>)('%s: refused', async (_, probe, msg) => {
    expect(await attempt(pool(), [probe])).toMatchObject({ code: '42501', message: expect.stringMatching(msg) });
  });

  it('cannot write an audit snapshot, which app_user only reads', async () => {
    const r = await attempt(pool(), [[`INSERT INTO audit_snapshots (company_id) VALUES ($1)`, [company]]]);
    expect(r?.code).toBe('42501');
  });
});

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

  it('withUserAuth (service): invite/[token] POST adds the invitee to a company it is not yet in', async () => {
    const r = await callRoute(inviteRoute, { sub: invitee, method: 'POST', query: { token: inviteToken } });
    expect(r.status).toBe(200);
    const m = await fixture.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, invitee]);
    expect(m.rows).toEqual([{ role: 'viewer' }]);
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
    const { token } = await createEmailVerificationToken(admin, { email: `${admin}@test.local`, firstName: 'A', lastName: 'B', companyName: 'S07b', phone: null,
      annualTurnoverCents: null, signupType: 'business' } as never);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runAuditTx (service pool, then SET LOCAL ROLE app_user) runs as app_user', async () => {
    const who = await runAuditTx({ userId: me, companyId: company, claims: { sub: me } }, 'READ COMMITTED',
      async (c) => (await c.query('SELECT current_user AS u')).rows[0].u as string);
    expect(who).toBe('app_user');
  });
});

describe('S-07b: migration 910', () => {
  it('gives app_service a policy for every command an app_user or PUBLIC policy admits', async () => {
    const missing = await fixture.query(`
      SELECT DISTINCT p.polrelid::regclass::text AS t, p.polcmd AS c FROM pg_policy p
       WHERE p.polpermissive AND p.polname NOT LIKE 'app\\_service\\_%'
         AND (p.polroles = '{0}'::oid[] OR 'app_user'::regrole = ANY (p.polroles))
         AND NOT (coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'false'
                  AND coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'false') = 'false')
         AND NOT EXISTS (SELECT 1 FROM pg_policy s WHERE s.polrelid = p.polrelid
                         AND 'app_service'::regrole = ANY (s.polroles) AND s.polcmd IN (p.polcmd, '*'))`);
    expect(missing.rows).toEqual([]);
  });

  it('re-applies as a NON-superuser postgres, twice', async () => {
    const c = await fixture.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER ROLE postgres NOSUPERUSER');
      await c.query(MIGRATION);
      await c.query(MIGRATION);
      expect((await c.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0].rolsuper).toBe(false);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it.each([
    ['isaflow_app granted an owner', 'GRANT migration_admin TO isaflow_app', /910: isaflow_app can reach role migration_admin/],
    ['isaflow_app granted app_service', 'GRANT app_service TO isaflow_app', /910: isaflow_app can reach role app_service/],
    ['isaflow_service granted migration_admin', 'GRANT migration_admin TO isaflow_service', /910: isaflow_service can reach role migration_admin/],
    ['app_user made BYPASSRLS', 'ALTER ROLE app_user BYPASSRLS', /which is superuser, BYPASSRLS/],
    ['app_service owning a table', 'CREATE TABLE s07b_mutant (x int); ALTER TABLE s07b_mutant OWNER TO app_service', /app_service, which owns objects/],
    ['isaflow_app INHERIT', 'ALTER ROLE isaflow_app INHERIT', /910: isaflow_app must be NOINHERIT/],
    ['isaflow_app inheriting app_user through the grant (PG 16)', `DO $$ BEGIN IF current_setting('server_version_num')::int >= 160000
      THEN EXECUTE 'REVOKE app_user FROM isaflow_app'; EXECUTE 'GRANT app_user TO isaflow_app WITH INHERIT TRUE';
      ELSE EXECUTE 'ALTER ROLE isaflow_app INHERIT'; END IF; END $$`, /910: isaflow_app must be NOINHERIT and must not inherit/],
  ])('the guard refuses the mutant: %s', async (_, mutate, msg) => {
    const c = await fixture.connect();
    try {
      await c.query('BEGIN');
      await c.query(mutate);
      await expect(c.query(lastDoBlock(MIGRATION))).rejects.toThrow(msg);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
