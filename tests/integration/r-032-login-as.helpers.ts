/**
 * One company, a platform admin, and an OWNER target the admin can "Login as"
 * through the real route — the fixture the R-032 L5 suites share. GoTrue's HTTP
 * endpoints are faked (r-032-fake-gotrue.helpers.ts); everything else is real.
 */
import { vi } from 'vitest';
import type { Pool } from 'pg';
import type { NextApiHandler } from 'next';
import startImpersonation from '../../pages/api/admin/users/[id]/impersonate';
import { applyCookies, request, response } from './mfa-impersonation-postgres.helpers';
import { deletePlantedDocuments } from './approval-document.helpers';
import { fakeGotrueFetch, signSession, type FakeGotrue } from './r-032-fake-gotrue.helpers';

export type Jar = Record<string, string>;
export type Call = { method?: string; body?: unknown; query?: Record<string, string>; url?: string };

export interface LoginAsFixture {
  company: string;
  platformAdmin: string;
  target: string;
  setUp(): Promise<void>;
  tearDown(): Promise<void>;
  /** Cookies of a "Login as target" session started through the real route. */
  loginAsTarget(): Promise<Jar>;
  /** The target's own, ordinary session. */
  ownSession(): Promise<Jar>;
  call(handler: NextApiHandler, jar: Jar, call: Call): Promise<ReturnType<typeof response>>;
}

export function loginAsFixture(pool: Pool, label: string): LoginAsFixture {
  const company = crypto.randomUUID();
  const platformAdmin = crypto.randomUUID();
  const target = crypto.randomUUID();
  const gotrue: FakeGotrue = { nextSessionId: crypto.randomUUID(), minted: [] };

  return {
    company, platformAdmin, target,

    async setUp() {
      vi.stubEnv('SUPABASE_ANON_KEY', 'r032-anon');
      vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'r032-service');
      vi.stubEnv('ENCRYPTION_KEY', 'disposable-r032-stash-encryption-key-over-32-characters');
      vi.stubGlobal('fetch', fakeGotrueFetch((email) => email.split('@')[0]!, gotrue));
      await pool.query(`INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'super_admin',true),($3,$4,'admin',true)`,
        [platformAdmin, `${platformAdmin}@test.local`, target, `${target}@test.local`]);
      await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, `${label} ${company.slice(0, 8)}`]);
      await pool.query(`INSERT INTO company_users(company_id,user_id,role,is_default) VALUES($1,$2,'owner',true)`,
        [company, target]);
    },

    async tearDown() {
      try {
        await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id=$1', [platformAdmin]);
        await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [platformAdmin]);
        await pool.query('DELETE FROM admin_impersonation_stash WHERE admin_user_id=$1', [platformAdmin]);
        await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
        await deletePlantedDocuments(pool, [company]);
        await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
        await pool.query('DELETE FROM companies WHERE id=$1', [company]);
        await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[platformAdmin, target]]);
        await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },

    async loginAsTarget() {
      const jar: Jar = {
        'sb-access-token': await signSession(platformAdmin, crypto.randomUUID(), 'aal2'),
        'sb-refresh-token': 'admin-refresh',
      };
      const started = response();
      await startImpersonation(request(jar, 'POST', target), started.res);
      if (started.state.statusCode !== 200) throw new Error(`Login as failed: ${JSON.stringify(started.state.body)}`);
      applyCookies(jar, started);
      return { 'sb-access-token': jar['sb-access-token']!, 'sb-impersonation-proof': jar['sb-impersonation-proof']!,
        'sb-admin-stash': jar['sb-admin-stash']!, active_company_id: company };
    },

    async ownSession() {
      return { 'sb-access-token': await signSession(target, crypto.randomUUID(), 'aal2'), active_company_id: company };
    },

    async call(handler, jar, { method = 'POST', body, query = {}, url = '/api/r-032-l5' }) {
      const req = request(jar, method) as never as { body: unknown; query: Record<string, string>; url: string };
      req.body = body;
      req.query = query;
      req.url = url;
      const result = response();
      await handler(req as never, result.res);
      return result;
    },
  };
}

export const reasonOf = (result: ReturnType<typeof response>) =>
  (result.state.body as { error?: { details?: { reason?: string } } } | undefined)?.error?.details?.reason;
