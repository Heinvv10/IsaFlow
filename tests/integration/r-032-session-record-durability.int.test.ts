/**
 * R-032 review round 1: the impersonation-session record must be durable, and
 * only the platform-admin path may write it.
 *
 * M1 — withPlatformAdmin runs "Login as" inside a transaction it COMMITs only
 * after the handler returns, and it does not hold the response. A record written
 * in that transaction is invisible to every other connection when the target
 * cookies go out, and is lost if the transaction then rolls back — while the
 * cookies are already on their way. The record must be committed on its own
 * connection before any cookie is set; a later rollback then leaves an orphan
 * row, which only over-refuses.
 *
 * L3 — migrations 348/352 set default privileges that grant app_user and
 * platform_admin INSERT/UPDATE/DELETE on every new table. Neither may alter a
 * record once written, and a tenant session must not be able to write one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import startImpersonation from '../../pages/api/admin/users/[id]/impersonate';
import { applyCookies, assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { deletePlantedDocuments, plantDocument } from './approval-document.helpers';
import { fakeGotrueFetch, signSession, type FakeGotrue } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const platformAdmin = crypto.randomUUID();
const target = crypto.randomUUID();
const requester = crypto.randomUUID();
const users = [platformAdmin, target, requester];
const company = crypto.randomUUID();
const gotrue: FakeGotrue = { nextSessionId: crypto.randomUUID(), minted: [] };

beforeAll(async () => {
  vi.stubEnv('SUPABASE_ANON_KEY', 'r032-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'r032-service');
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-r032-stash-encryption-key-over-32-characters');
  vi.stubGlobal('fetch', fakeGotrueFetch((email) => email.split('@')[0]!, gotrue));
  for (const [id, role] of [[platformAdmin, 'super_admin'], [target, 'admin'], [requester, 'manager']] as const) {
    await pool.query('INSERT INTO users(id,email,role,is_active) VALUES($1,$2,$3,true)', [id, `${id}@test.local`, role]);
  }
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, `R032d ${company.slice(0, 8)}`]);
  await pool.query(`INSERT INTO company_users(company_id,user_id,role,is_default)
    VALUES($1,$2,'admin',true),($1,$3,'manager',true)`, [company, target, requester]);
  await pool.query(`INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,
    condition_value,approver_role,is_active) VALUES($1,'r032d admin any','supplier_invoice','amount','any',0,'admin',true)`,
  [company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id=$1', [platformAdmin]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [platformAdmin]);
    await pool.query('DELETE FROM admin_impersonation_stash WHERE admin_user_id=$1', [platformAdmin]);
    await pool.query('DELETE FROM approval_requests WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=$1', [company]);
    await deletePlantedDocuments(pool, [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
  } finally {
    await pool.end();
    await observer.end();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

async function decide(jar: Record<string, string>, body: Record<string, unknown>) {
  const req = request(jar, 'POST') as never as { body: unknown; url: string };
  req.body = body;
  req.url = '/api/accounting/approval-requests';
  const result = response();
  await approvalRequests(req as never, result.res);
  return result;
}

describe('M1 — the session record is committed before the target cookies are set', () => {
  it('is visible to another connection at cookie time and survives the request rolling back', async () => {
    const sessionId = gotrue.nextSessionId;
    const jar: Record<string, string> = {
      'sb-access-token': await signSession(platformAdmin, crypto.randomUUID(), 'aal2'),
      'sb-refresh-token': 'admin-refresh',
    };
    const started = response();
    const realSetHeader = started.res.setHeader.bind(started.res);
    let seenAtCookieTime: Promise<number> | undefined;
    started.res.setHeader = ((name: string, value: unknown) => {
      if (!seenAtCookieTime && name.toLowerCase() === 'set-cookie' && String(value).includes('sb-access-token=')) {
        // Read from a connection that is not the request's, as the approve route will.
        seenAtCookieTime = observer.query('SELECT 1 FROM impersonation_sessions WHERE session_id=$1', [sessionId])
          .then((r) => r.rowCount ?? 0);
        // The request transaction must never commit from here on — the COMMIT that
        // fails after the cookies went out. withPlatformAdmin's M6 flag forces it.
        als.getStore()!.criticalAuditFailed = true;
      }
      return realSetHeader(name, value as never);
    }) as typeof started.res.setHeader;
    await startImpersonation(request(jar, 'POST', target), started.res);

    expect(seenAtCookieTime, 'the auth cookie was never set').toBeDefined();
    expect(await seenAtCookieTime).toBe(1);
    const recorded = await pool.query('SELECT actor_user_id, target_user_id FROM impersonation_sessions WHERE session_id=$1',
      [sessionId]);
    expect(recorded.rows).toEqual([{ actor_user_id: platformAdmin, target_user_id: target }]);

    // The cookies that escaped are still refused an approval decision.
    applyCookies(jar, started);
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 25000, requester);
    const raised = await decide({ 'sb-access-token': await signSession(requester, crypto.randomUUID(), 'aal2'),
      active_company_id: company }, { action: 'request', documentType: 'supplier_invoice', documentId });
    const requestId = (raised.state.body as { data: { id: string } }).data.id;
    const approved = await decide({ 'sb-access-token': jar['sb-access-token']!, active_company_id: company },
      { action: 'approve', requestId });
    expect(approved.state.statusCode, JSON.stringify(approved.state.body)).toBe(403);
    expect((await pool.query('SELECT status FROM approval_requests WHERE id=$1', [requestId])).rows[0].status)
      .toBe('pending');
  });
});

describe('L3 — nobody but the platform-admin path writes the record, and nobody alters it', () => {
  it('grants app_user SELECT only and platform_admin SELECT + INSERT only', async () => {
    const { rows } = await pool.query(`SELECT r.role, p.priv,
        has_table_privilege(r.role, 'impersonation_sessions', p.priv) AS granted
      FROM unnest(ARRAY['app_user','platform_admin']) AS r(role),
           unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p(priv)`);
    const granted = rows.filter((r: { granted: boolean }) => r.granted).map((r: { role: string; priv: string }) =>
      `${r.role}:${r.priv}`).sort();
    expect(granted).toEqual(['app_user:SELECT', 'platform_admin:INSERT', 'platform_admin:SELECT']);
  });

  it('refuses INSERT, UPDATE and DELETE from a tenant session, even on its own row', async () => {
    const sessionId = crypto.randomUUID();
    await pool.query('INSERT INTO impersonation_sessions(session_id,actor_user_id,target_user_id) VALUES($1,$2,$3)',
      [sessionId, platformAdmin, target]);
    const asTenant = async (statement: string, params: unknown[]) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`,
          [JSON.stringify({ sub: target, session_id: sessionId })]);
        return await client.query(statement, params);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    // The row is this session's own, so the SELECT policy shows it: an UPDATE or
    // DELETE would reach it if the privilege were there.
    expect((await asTenant('SELECT 1 FROM impersonation_sessions', [])).rowCount).toBe(1);
    await expect(asTenant('INSERT INTO impersonation_sessions(session_id,actor_user_id,target_user_id) VALUES($1,$2,$2)',
      [crypto.randomUUID(), target])).rejects.toThrow(/permission denied for table impersonation_sessions/);
    await expect(asTenant('UPDATE impersonation_sessions SET session_id=$1', [crypto.randomUUID()]))
      .rejects.toThrow(/permission denied for table impersonation_sessions/);
    await expect(asTenant('DELETE FROM impersonation_sessions', []))
      .rejects.toThrow(/permission denied for table impersonation_sessions/);
  });
});
