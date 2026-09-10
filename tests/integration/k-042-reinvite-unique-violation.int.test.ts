/**
 * K-042: re-inviting an address that already has an invitation row for the same
 * company raised a unique violation instead of resending.
 *
 * pages/api/invitations/index.ts INSERTed into company_invitations with no
 * ON CONFLICT, and migration 258 declares UNIQUE(company_id, email). The route
 * was withAuth(withCsrf(handler)) with no withErrorHandler, so the 23505
 * propagated out of the handler and Next answered 500.
 *
 * The fix refreshes the row in place (new token, new expiry, chosen role,
 * accepted/error state cleared) and adds withErrorHandler to the chain.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { response } from './mfa-impersonation-postgres.helpers';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { NextApiRequest } from 'next';
import invitations from '../../pages/api/invitations/index';

// The real sendEmail resolves { success, messageId? } and never throws on a
// delivery failure — the route branches on `success`, so the mock has to carry
// it or a successful resend reads as a failed one.
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'disposable-message-id' })),
}));

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const owner = crypto.randomUUID();
const email = `k042-${company}@test.local`;
const existingInvite = crypto.randomUUID();
const otherCompanyInvite = crypto.randomUUID();
const otherCompanyToken = `k042-other-${otherCompanyInvite.replace(/-/g, '')}`;
const firstToken = `k042-first-${existingInvite.replace(/-/g, '')}`;
const gotrueUser = crypto.randomUUID();
const originalFetch = globalThis.fetch;
let gotrueFails = false;
let token = '';

function inviteRequest(role: string, remote: string): NextApiRequest {
  const csrf = 'disposable-postgres-workflow-csrf-0123456789';
  const cookies = { 'sb-access-token': token, active_company_id: company, isaflow_csrf: csrf };
  return {
    method: 'POST', url: '/api/invitations', query: {}, cookies,
    headers: {
      cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': csrf,
    },
    body: { email, role },
    socket: { remoteAddress: remote },
  } as unknown as NextApiRequest;
}

beforeAll(async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'disposable-service-role-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'disposable-anon-key');

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K042 company', otherCompany, 'K042 other company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
    [owner, `k042-owner-${owner}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, owner]);
  // The first invitation, exactly as the route would have left it, plus an
  // invitation for the SAME address owned by a different tenant.
  await pool.query(
    `INSERT INTO company_invitations(id,company_id,email,role,invited_by,token,expires_at,accepted_at,email_error)
     VALUES($1,$2,$3,'viewer',$4,$5,now()+interval '7 days',now(),'smtp refused'),
           ($6,$7,$3,'viewer',$4,$8,now()+interval '7 days',NULL,NULL)`,
    [existingInvite, company, email, owner, firstToken, otherCompanyInvite, otherCompany, otherCompanyToken]);
  token = await new SignJWT({ sub: owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('External network forbidden in disposable invite fixture');
    }
    if (url.pathname === '/admin/users') {
      if (gotrueFails) {
        return new Response(JSON.stringify({ msg: 'disposable gotrue outage' }),
          { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: gotrueUser, email }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  try {
    await pool.query('DELETE FROM company_invitations WHERE company_id=ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [owner]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`invitations:company:${company}%`]);
  } finally { await pool.end(); }
});

it('resends an existing invitation instead of raising a unique violation', async () => {
  const result = response();

  await expect(invitations(inviteRequest('viewer', '127.0.0.83'), result.res)).resolves.toBeUndefined();

  expect(result.state.statusCode).toBe(201);
  const rows = await pool.query(
    'SELECT id, token, accepted_at, email_error, email_sent_at FROM company_invitations WHERE company_id=$1 AND email=$2',
    [company, email]);
  // One row, refreshed in place: same id, new token, acceptance and the failed
  // send both cleared so the invitee can use the new link.
  expect(rows.rowCount).toBe(1);
  expect(rows.rows[0].id).toBe(existingInvite);
  expect(rows.rows[0].token).not.toBe(firstToken);
  expect(rows.rows[0].accepted_at).toBeNull();
  expect(rows.rows[0].email_error).toBeNull();
  expect(rows.rows[0].email_sent_at).not.toBeNull();
});

it('leaves another tenant\'s invitation for the same address untouched', async () => {
  const rows = await pool.query(
    'SELECT token, role FROM company_invitations WHERE id=$1 AND company_id=$2',
    [otherCompanyInvite, otherCompany]);
  expect(rows.rows).toEqual([{ token: otherCompanyToken, role: 'viewer' }]);
});

it('a re-invite at a different role rewrites the role and pushes the expiry out', async () => {
  const before = await pool.query('SELECT token, expires_at FROM company_invitations WHERE id=$1', [existingInvite]);
  const result = response();

  await invitations(inviteRequest('manager', '127.0.0.83'), result.res);

  expect(result.state.statusCode).toBe(201);
  const after = await pool.query('SELECT role, token, expires_at FROM company_invitations WHERE id=$1', [existingInvite]);
  expect(after.rows[0].role).toBe('manager');
  expect(after.rows[0].token).not.toBe(before.rows[0].token);
  expect(after.rows[0].expires_at.getTime()).toBeGreaterThan(before.rows[0].expires_at.getTime());
});

it('rejects an unknown role without writing anything', async () => {
  const before = await pool.query('SELECT token FROM company_invitations WHERE id=$1', [existingInvite]);
  const result = response();

  await invitations(inviteRequest('superuser', '127.0.0.83'), result.res);

  expect(result.state.statusCode).toBe(400);
  const after = await pool.query('SELECT token FROM company_invitations WHERE id=$1', [existingInvite]);
  expect(after.rows[0].token).toBe(before.rows[0].token);
});

it('answers an upstream failure with a JSON error envelope instead of throwing', async () => {
  gotrueFails = true;
  const result = response();

  try {
    // withErrorHandler is what turns an unexpected throw into a response. Without
    // it in the chain this rejects and the caller sees a bare Next 500.
    await expect(invitations(inviteRequest('viewer', '127.0.0.83'), result.res)).resolves.toBeUndefined();
    expect(result.state.statusCode).toBe(500);
    expect(result.state.body).toMatchObject({ success: false });
  } finally {
    gotrueFails = false;
  }
});
