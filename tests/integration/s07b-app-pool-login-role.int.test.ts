// tests/integration/s07b-app-pool-login-role.int.test.ts
//
// Audit 2026-10-18 S-07b: the app's pools must not log in as the owner.
//
// Every pool built from DATABASE_URL logged in as `postgres`, which owns users
// and bypasses RLS. withAuth's `SET LOCAL ROLE app_user` is undone by injected
// set_config('role','none',true) or RESET ROLE: the session user comes back,
// and the owner can set users.role = 'super_admin' or read any tenant.
// Migration 915 gives the request pools isaflow_app (NOINHERIT, member of
// app_user only) and the no-transaction paths isaflow_service (app_service);
// 916 makes the member guards judge app_service as they judge app_user.
//
// Each attack runs on the pool the app itself builds (getAuthPool, getDbPool)
// from the env production will have, logged in for real, and must be refused
// with the message that says WHY, so an RLS refusal, a guard and a failed SET
// ROLE cannot pass for one another. Legitimate paths:
// s07b-app-pool-login-role.paths.int.test.ts; the migrations themselves:
// s07b-app-pool-login-role.migration.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { attempt, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const { me, owner, company, other, otherJournal, session } = ids;

beforeAll(() => setup(ids), 60000);
afterAll(() => teardown(ids, [getAuthPool(), getDbPool()]));

const asMe = { asRequest: { sub: me, companyId: company } };
const ownerWrite: [string, unknown[]] = [`UPDATE users SET role = 'super_admin' WHERE id = $1`, [me]];
const otherTenantRead: [string, unknown[]] = ['SELECT name FROM companies WHERE id = $1', [other]];
const otherJournalRead: [string, unknown[]] = ['SELECT description FROM gl_journal_entries WHERE id = $1', [otherJournal]];
// The member guards still exempt isaflow_app itself (it holds no app_service):
// what keeps this out is that, after RESET ROLE, isaflow_app holds no grant at all.
const memberWrite: [string, unknown[]] = [`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [other, me]];

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
  ])('after %s, the owner write, a member write and other tenants\' rows are refused outright', async (_, escape) => {
    for (const [probe, table] of [[ownerWrite, 'users'], [otherTenantRead, 'companies'], [otherJournalRead, 'gl_journal_entries'],
      [memberWrite, 'company_users']] as Array<[[string, unknown[]], string]>) {
      expect(await attempt(pool(), [[escape], probe], asMe))
        .toMatchObject({ code: '42501', message: `permission denied for table ${table}` });
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

  // S-07b verifier P1: the owner-run views clients and app_settings (917 sets security_invoker).
  it.each([
    ['reads another tenant\'s customers through clients', `SELECT name FROM clients WHERE name = 'S07b other tenant customer'`],
    ['reads another tenant\'s settings through app_settings', `SELECT value FROM app_settings WHERE key = 's07b_secret'`],
    ['writes another tenant\'s customers through clients', `UPDATE clients SET notes = 'written' WHERE name = 'S07b other tenant customer' RETURNING id`],
  ])('app_user no longer %s', async (_, text) => {
    const c = await pool().connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('app.current_company_id', $2, true)`,
        [JSON.stringify({ sub: me }), company]);
      expect((await c.query(text)).rowCount).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release(true);
    }
  });

  it('app_user cannot rewrite the migration history (917)', async () => {
    expect(await attempt(pool(), [[`DELETE FROM schema_migrations WHERE name LIKE '915%'`]], asMe))
      .toMatchObject({ code: '42501', message: 'permission denied for table schema_migrations' });
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
    // With the runbook's event trigger installed (production), DDL is refused before the ownership check.
    ['disables triggers', ['ALTER TABLE users DISABLE TRIGGER ALL', []],
      /^(must be owner of table users|DDL \(ALTER TABLE\) refused for isaflow_service \(as isaflow_service\))$/],
    ['writes the forensic change log', ['DELETE FROM entity_changes', []], /^permission denied for table entity_changes$/],
    ['rewrites the migration history', [`DELETE FROM schema_migrations WHERE name LIKE '915%'`, []], /^permission denied for table schema_migrations$/],
    ['SET ROLE postgres', ['SET ROLE postgres', []], /permission denied to set role "postgres"/],
    ['SET ROLE migration_admin', ['SET ROLE migration_admin', []], /permission denied to set role/],
    ['SET ROLE platform_admin', ['SET ROLE platform_admin', []], /permission denied to set role/],
  ] as Array<[string, [string, unknown[]], RegExp]>)('%s: refused', async (_, probe, msg) => {
    expect(await attempt(pool(), [probe])).toMatchObject({ code: '42501', message: expect.stringMatching(msg) });
  });

  it('cannot write an audit snapshot, which app_user only reads', async () => {
    expect((await attempt(pool(), [[`INSERT INTO audit_snapshots (company_id) VALUES ($1)`, [company]]]))?.code).toBe('42501');
  });

  it('does not see impersonation sessions it cannot name', async () => {
    const r = await pool().query('SELECT count(*)::int AS n FROM impersonation_sessions WHERE session_id = $1', [session]);
    expect(r.rows[0].n).toBe(0);
  });
});

// S-07b breaker F1: the member guards let every role but app_user through.
describe('S-07b (916): the service pool takes app_user\'s member rules', () => {
  const pool = (): Pool => getDbPool();
  const asOwner = { claims: { sub: owner, companyId: company } };

  it.each([
    ['adds a member to another tenant', `INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
      () => [other, me], /^Only owners and admins can change the members of a company$/],
    ['writes an invitation', `INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
      VALUES ($1, 'x@test.local', 'owner', $2, 'h', NOW() + interval '1 day')`, () => [other, me], /^Only owners and admins can invite users\.$/],
  ] as Array<[string, string, () => unknown[], RegExp]>)('with no claims, refused when it %s', async (_, text, params, msg) => {
    expect(await attempt(pool(), [[text, params()]])).toMatchObject({ message: expect.stringMatching(msg) });
  });

  it.each([
    ['grants an unknown role', `INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'super_admin')`,
      () => [company, ids.invitee], /^Invalid role/],
    ['moves a membership', `UPDATE company_users SET company_id = $1 WHERE company_id = $2 AND user_id = $3`,
      () => [other, company, me], /^Only owners and admins can change the members of a company$/],
    ['removes the last owner', `DELETE FROM company_users WHERE company_id = $1 AND user_id = $2`,
      () => [company, owner], /^You cannot remove yourself from the company\.$/],
    ['demotes the last owner', `UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2`,
      () => [company, owner], /^Cannot change role: this is the last owner of the company\.$/],
  ] as Array<[string, string, () => unknown[], RegExp]>)('with an owner\'s forged claims, refused when it %s', async (_, text, params, msg) => {
    expect(await attempt(pool(), [[text, params()]], asOwner)).toMatchObject({ message: expect.stringMatching(msg) });
  });
});
