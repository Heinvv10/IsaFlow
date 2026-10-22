/**
 * Fixture for the s07b-app-pool-login-role*.int.test.ts suites: real logins as
 * the app's login roles (migrations 910, 911), one tenant pair seeded per
 * file, and probes that report how a statement was refused.
 *
 * The roles must be reached by a real LOGIN, not `options=-c role=X` on the
 * harness's `postgres` URL: RESET ROLE and set_config('role','none') return to
 * the SESSION user, which with `-c role=` would still be `postgres`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { NextApiRequest } from 'next';
import { vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import { response } from './mfa-impersonation-postgres.helpers';
import { pool as fixture, urlAsRole } from './s07-users-privilege-columns.helpers';

export { fixture };

/** The login roles migration 910 creates, and the pool each one serves. */
export type LoginRole = 'isaflow_app' | 'isaflow_service';

export const CRON = 's07b-cron-secret-0123456789abcdef0123456789';

export const migration = (name: string): string =>
  readFileSync(join(process.cwd(), 'scripts/migrations/sql', name), 'utf8');

/**
 * Give `role` LOGIN and a password (as the ops step does in production) and
 * return the harness's URL rewritten to log in as it.
 */
export async function loginUrl(fixtureUrl: string, role: LoginRole): Promise<string> {
  const password = crypto.randomUUID();
  await fixture.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
  const url = new URL(fixtureUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** The ids one suite file seeds, all fresh per file. */
export interface S07bIds {
  me: string; owner: string; admin: string; invitee: string;
  company: string; other: string; otherJournal: string;
  inviteToken: string; pat: string; session: string;
}

export function newIds(): S07bIds {
  return {
    me: crypto.randomUUID(), owner: crypto.randomUUID(), admin: crypto.randomUUID(), invitee: crypto.randomUUID(),
    company: crypto.randomUUID(), other: crypto.randomUUID(), otherJournal: crypto.randomUUID(),
    inviteToken: `s07b-${crypto.randomUUID()}`, pat: `pat_${crypto.randomUUID().replace(/-/g, '')}`,
    session: `s07b-${crypto.randomUUID()}`,
  };
}

/** The MCP connector flag, when setup had to create it (the baseline holds no data). */
let mcpFlag: string | null = null;

/**
 * Point the app's pools at the production logins and seed two tenants:
 * `company` (me = admin, owner = its only owner) and `other`.
 */
export async function setup(ids: S07bIds): Promise<void> {
  const fixtureUrl = process.env.DATABASE_URL!;
  vi.stubEnv('MIGRATION_ADMIN_DATABASE_URL', urlAsRole('migration_admin'));
  vi.stubEnv('DATABASE_URL', await loginUrl(fixtureUrl, 'isaflow_app'));
  vi.stubEnv('SERVICE_DATABASE_URL', await loginUrl(fixtureUrl, 'isaflow_service'));
  vi.stubEnv('CRON_SECRET', CRON);
  vi.stubEnv('SUPABASE_ANON_KEY', 'x');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'x');
  const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
  for (const [id, name] of [[ids.company, 'S07b mine'], [ids.other, 'S07b other tenant']]) {
    await q(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [id, name]);
    await q(`INSERT INTO flow_wallet (company_id, month_flows_used) VALUES ($1, 7)`, [id]);
  }
  for (const [id, role] of [[ids.me, 'viewer'], [ids.owner, 'viewer'], [ids.admin, 'super_admin'], [ids.invitee, 'viewer']]) {
    await q(`INSERT INTO users (id, email, first_name, last_name, role, is_active, status)
      VALUES ($1, $2, 'Before', 'Before', $3, true, 'active')`, [id, `${id}@test.local`, role]);
  }
  await q(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'admin', true), ($1, $3, 'owner', true)`,
    [ids.company, ids.me, ids.owner]);
  await q(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, created_by)
    VALUES ($1, $2, 'S07B-1', '2026-01-01', 'other tenant', 'draft', 'manual', $3)`, [ids.otherJournal, ids.other, ids.admin]);
  await q(`INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
    VALUES ($1, $2, 'viewer', $3, $4, NOW() + interval '1 day')`,
  [ids.company, `${ids.invitee}@test.local`, ids.me, hashInviteToken(ids.inviteToken)]);
  await q(`INSERT INTO personal_access_tokens (user_id, company_id, token_hash, token_prefix, name, scopes, expires_at)
    VALUES ($1, $2, $3, $4, 's07b', '{read:reports}', NOW() + interval '1 day')`,
  [ids.me, ids.company, createHash('sha256').update(ids.pat).digest('hex'), ids.pat.slice(0, 12)]);
  await q(`INSERT INTO impersonation_sessions (session_id, actor_user_id, target_user_id) VALUES ($1, $2, $3)`,
    [ids.session, ids.admin, ids.me]);
  const flag = await q(`INSERT INTO feature_flags (code, name) SELECT 'mcp_connector', 'MCP connector'
    WHERE NOT EXISTS (SELECT 1 FROM feature_flags WHERE code = 'mcp_connector') RETURNING id`);
  mcpFlag = (flag.rows[0]?.id as string | undefined) ?? null;
  await q(`INSERT INTO company_feature_overrides (company_id, feature_id, enabled, set_by)
    SELECT $1, id, true, $2 FROM feature_flags WHERE code = 'mcp_connector'`, [ids.company, ids.admin]);
}

/** Remove what setup seeded, then end `pools` and the fixture connection. */
export async function teardown(ids: S07bIds, pools: Pool[]): Promise<void> {
  try {
    const companies = [ids.company, ids.other];
    for (const t of ['company_feature_overrides', 'personal_access_tokens', 'company_invitations', 'company_users',
      'gl_journal_entries', 'flow_wallet']) {
      await fixture.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [companies]);
    }
    const users = [ids.me, ids.owner, ids.admin, ids.invitee];
    await fixture.query('DELETE FROM impersonation_sessions WHERE session_id = $1', [ids.session]);
    await fixture.query('DELETE FROM auth_email_verification_tokens WHERE gotrue_user_id = ANY($1)', [users]);
    await fixture.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    await fixture.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
    if (mcpFlag) await fixture.query('DELETE FROM feature_flags WHERE id = $1', [mcpFlag]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await Promise.all([...pools.map((p) => p.end()), fixture.end()]);
  }
}

/** A refused statement's SQLSTATE and message; null when everything succeeded. */
export interface Refusal { code: string; message: string }

/**
 * Run `steps` in order on one client of `pool`, inside a transaction that is
 * always rolled back. The transaction opens the way withAuth's does (BEGIN,
 * SET LOCAL ROLE app_user, the caller's claims) when `asRequest` is set;
 * `claims` alone sets the claims without the role.
 */
export async function attempt(pool: Pool, steps: Array<[string, unknown[]?]>,
  opts: { asRequest?: { sub: string; companyId: string }; claims?: { sub: string; companyId: string } } = {}): Promise<Refusal | null> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opts.asRequest) await client.query('SET LOCAL ROLE app_user');
    const claims = opts.asRequest ?? opts.claims;
    if (claims) {
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: claims.sub })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [claims.companyId]);
    }
    try {
      for (const [text, params] of steps) await client.query(text, params);
      return null;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code ?? 'none', message: e.message ?? String(err) };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    // A session-level SET ROLE / SET SESSION AUTHORIZATION that got through
    // must not ride back into the pool.
    client.release(true);
  }
}

type Route = (req: never, res: never) => Promise<unknown>;

/** Call a cron route the way the systemd timers do: POST with X-Cron-Secret. */
export async function callCron(route: unknown, secret: string): Promise<{ status: number; body: unknown }> {
  const req = { method: 'POST', url: '/api/cron/fixture', headers: { 'x-cron-secret': secret },
    cookies: {}, query: {}, body: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as NextApiRequest;
  const result = response();
  await (route as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body };
}

/** The top-level `DO $$ ... END $$;` block of a migration that contains `marker`. */
export function doBlock(migrationText: string, marker: string): string {
  const at = migrationText.indexOf(marker);
  const start = migrationText.lastIndexOf('\nDO $$', at);
  const end = migrationText.indexOf('END $$;', at);
  if (at < 0 || start < 0 || end < 0) throw new Error(`no DO block containing ${marker}`);
  return migrationText.slice(start + 1, end + 'END $$;'.length);
}
