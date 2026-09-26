/**
 * R-032: approval decisions are refused while the session is an impersonation.
 *
 * "Login as" hands a platform admin a GENUINE GoTrue session for the target, so
 * every request after it authenticates as the target: `assertMayDecide` compared
 * `requested_by` with the target's id and `decided_by` recorded the target. The
 * admin could clear a request the target never saw, under the target's name, and
 * the separation-of-duties check measured the wrong person.
 *
 * Decision (Hein): refuse the decision outright under impersonation — 403, nothing
 * written, fail closed. The admin's real identity never reaches withAuth, so the
 * refusal must key on something the admin's browser cannot remove: the proof and
 * stash cookies are ordinary cookies and deleting them leaves a working target
 * session. These tests drive the real "Login as", end-impersonation and approval
 * routes; only GoTrue's HTTP endpoints are faked (r-032-fake-gotrue.helpers.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import startImpersonation from '../../pages/api/admin/users/[id]/impersonate';
import endImpersonation from '../../pages/api/auth/end-impersonation';
import { applyCookies, assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { deletePlantedDocuments, plantDocument } from './approval-document.helpers';
import { fakeGotrueFetch, signSession, type FakeGotrue } from './r-032-fake-gotrue.helpers';
import { log } from '@/lib/logger';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const platformAdmin = crypto.randomUUID();
const target = crypto.randomUUID();
const requester = crypto.randomUUID();
const users = [platformAdmin, target, requester];
const company = crypto.randomUUID();
const adminCompany = crypto.randomUUID();
const gotrue: FakeGotrue = { nextSessionId: crypto.randomUUID(), minted: [] };

beforeAll(async () => {
  vi.stubEnv('SUPABASE_ANON_KEY', 'r032-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'r032-service');
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-r032-stash-encryption-key-over-32-characters');
  vi.stubGlobal('fetch', fakeGotrueFetch((email) => email.split('@')[0]!, gotrue));
  for (const [id, role] of [[platformAdmin, 'super_admin'], [target, 'admin'], [requester, 'manager']] as const) {
    await pool.query('INSERT INTO users(id,email,role,is_active) VALUES($1,$2,$3,true)', [id, `${id}@test.local`, role]);
  }
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, `R032 ${company.slice(0, 8)}`, adminCompany, `R032 admin ${adminCompany.slice(0, 8)}`]);
  await pool.query(`INSERT INTO company_users(company_id,user_id,role,is_default)
    VALUES($1,$2,'admin',true),($1,$3,'manager',true),($4,$5,'owner',true)`,
  [company, target, requester, adminCompany, platformAdmin]);
  await pool.query(`INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,
    condition_value,approver_role,is_active) VALUES($1,'r032 admin any','supplier_invoice','amount','any',0,'admin',true)`,
  [company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id=$1', [platformAdmin]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [platformAdmin]);
    await pool.query('DELETE FROM admin_impersonation_stash WHERE admin_user_id=$1', [platformAdmin]);
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM approval_requests WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=$1', [company]);
    await deletePlantedDocuments(pool, [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [[company, adminCompany]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, adminCompany]]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
  } finally {
    await pool.end();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

type Jar = Record<string, string>;
const ownSession = async (userId: string): Promise<Jar> => ({
  'sb-access-token': await signSession(userId, crypto.randomUUID(), 'aal2'), active_company_id: company,
});

async function decide(jar: Jar, body: Record<string, unknown>) {
  const req = request(jar, 'POST') as never as { body: unknown; url: string };
  req.body = body;
  req.url = '/api/accounting/approval-requests';
  const result = response();
  await approvalRequests(req as never, result.res);
  return result;
}
const reasonOf = (result: ReturnType<typeof response>) =>
  (result.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;

/** A pending request raised by the manager, which the target (an admin) may clear on their own session. */
async function pendingRequest(): Promise<string> {
  const documentId = await plantDocument(pool, company, 'supplier_invoice', 25000, requester);
  const raised = await decide(await ownSession(requester), { action: 'request', documentType: 'supplier_invoice', documentId });
  expect(raised.state.statusCode, JSON.stringify(raised.state.body)).toBe(200);
  return (raised.state.body as { data: { id: string } }).data.id;
}

const stored = async (requestId: string) => (await pool.query(
  'SELECT status, decided_by, decided_at FROM approval_requests WHERE id=$1', [requestId])).rows[0];

/** Platform admin → "Login as" the target through the real route; returns the target cookie jar. */
async function loginAsTarget(): Promise<Jar> {
  const jar: Jar = {
    'sb-access-token': await signSession(platformAdmin, crypto.randomUUID(), 'aal2'),
    'sb-refresh-token': 'admin-refresh',
  };
  const started = response();
  await startImpersonation(request(jar, 'POST', target), started.res);
  expect(started.state.statusCode, JSON.stringify(started.state.body)).toBe(200);
  applyCookies(jar, started);
  expect(jar.active_company_id).toBe(company);
  return jar;
}

async function expectRefusedUntouched(result: ReturnType<typeof response>, requestId: string) {
  expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(403);
  expect(reasonOf(result)).toBe('IMPERSONATION_FORBIDDEN');
  const row = await stored(requestId);
  expect(row.status).toBe('pending');
  expect(row.decided_by).toBeNull();
  expect(row.decided_at).toBeNull();
  const named = await pool.query('SELECT 1 FROM audit_log WHERE company_id=$1 AND user_id=$2', [company, target]);
  expect(named.rows).toHaveLength(0);
}

describe('R-032 — approval decisions under platform-admin impersonation', () => {
  it('refuses APPROVE from a "Login as" session and leaves the request pending', async () => {
    const requestId = await pendingRequest();
    const jar = await loginAsTarget();
    await expectRefusedUntouched(await decide(jar, { action: 'approve', requestId }), requestId);
  });

  it('refuses REJECT from a "Login as" session too', async () => {
    const requestId = await pendingRequest();
    const jar = await loginAsTarget();
    await expectRefusedUntouched(await decide(jar, { action: 'reject', requestId, notes: 'as target' }), requestId);
  });

  it('still refuses once the admin deletes every impersonation cookie from the browser', async () => {
    const requestId = await pendingRequest();
    const jar = await loginAsTarget();
    const stripped: Jar = { 'sb-access-token': jar['sb-access-token']!, active_company_id: jar.active_company_id! };
    await expectRefusedUntouched(await decide(stripped, { action: 'approve', requestId }), requestId);
  });

  it('still refuses a target token replayed after the impersonation was ended', async () => {
    const requestId = await pendingRequest();
    const jar = await loginAsTarget();
    const targetToken = jar['sb-access-token']!;
    const ended = response();
    await endImpersonation(request(jar, 'POST'), ended.res);
    expect(ended.state.statusCode, JSON.stringify(ended.state.body)).toBe(200);
    await expectRefusedUntouched(
      await decide({ 'sb-access-token': targetToken, active_company_id: company }, { action: 'approve', requestId }),
      requestId);
  });

  it('does not start the impersonation when its session cannot be recorded', async () => {
    // The session GoTrue is about to mint is already recorded, so recording it
    // again fails: the target cookies must never be issued in that case.
    const sessionId = gotrue.nextSessionId;
    await pool.query(`INSERT INTO impersonation_sessions(session_id,actor_user_id,target_user_id)
      VALUES($1,$2,$3)`, [sessionId, platformAdmin, target]);
    const jar: Jar = {
      'sb-access-token': await signSession(platformAdmin, crypto.randomUUID(), 'aal2'),
      'sb-refresh-token': 'admin-refresh',
    };
    const countOf = async (query: string) => Number((await pool.query(query, [platformAdmin, target])).rows[0].n);
    const auditQuery = `SELECT count(*) AS n FROM admin_audit_log
      WHERE admin_user_id=$1 AND target_id=$2 AND action='impersonation_start'`;
    const stashQuery = 'SELECT count(*) AS n FROM admin_impersonation_stash WHERE admin_user_id=$1 AND target_user_id=$2';
    const [auditsBefore, stashesBefore] = [await countOf(auditQuery), await countOf(stashQuery)];
    const errors = vi.spyOn(log, 'error');
    const started = response();
    let logged: unknown[][];
    try {
      await startImpersonation(request(jar, 'POST', target), started.res);
    } finally {
      logged = [...errors.mock.calls]; // mockRestore clears the recording
      errors.mockRestore();
    }
    expect(started.state.statusCode).toBe(500);
    const issued = ((started.headers.get('set-cookie') as string[] | undefined) ?? []).map((c) => c.split('=')[0]);
    expect(issued).not.toContain('sb-access-token');
    expect(issued).not.toContain('sb-admin-stash');
    expect(gotrue.minted).toContain(sessionId);
    // L4: the refused start is still on the record, its stash is cleaned up, and
    // the cleanup ran on a usable transaction (no 25P02 logged as a cleanup failure).
    expect(await countOf(auditQuery)).toBe(auditsBefore + 1);
    expect(await countOf(stashQuery)).toBe(stashesBefore);
    const cleanupFailures = logged.filter(([message]) => String(message).includes('cleanup failed'));
    expect(cleanupFailures).toEqual([]);
  });

  it('lets the same target approve on their OWN session', async () => {
    const requestId = await pendingRequest();
    await loginAsTarget(); // an impersonation of this user elsewhere must not block their own session
    const result = await decide(await ownSession(target), { action: 'approve', requestId });
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(200);
    const row = await stored(requestId);
    expect(row.status).toBe('approved');
    expect(row.decided_by).toBe(target);
  });

  it('keeps separation of duties: the requester still cannot approve their own request', async () => {
    const requestId = await pendingRequest();
    const result = await decide(await ownSession(requester), { action: 'approve', requestId });
    expect(result.state.statusCode).toBe(403);
    expect(reasonOf(result)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await stored(requestId)).status).toBe('pending');
  });

  it('fails closed on a session with no session id — impersonation cannot be ruled out', async () => {
    const requestId = await pendingRequest();
    const noSession = { 'sb-access-token': await signSession(target, undefined, 'aal2'), active_company_id: company };
    await expectRefusedUntouched(await decide(noSession, { action: 'approve', requestId }), requestId);
  });
});
