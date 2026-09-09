// RED regression: K-106 — when the invite email fails, POST /api/invitations
// answers 502 "Invitation created but email delivery failed. You can resend."
// withAuth ROLLBACKs on statusCode >= 500 (src/lib/auth/withAuth.ts:224-226),
// so nothing was created and there is nothing to resend.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: vi.fn(async () => { throw new Error('SMTP unreachable'); }),
}));
const gotrueUserId = crypto.randomUUID();
vi.mock('@/lib/auth/gotrue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminCreateUser: vi.fn(async () => ({ id: gotrueUserId })),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const owner = crypto.randomUUID();
const invitee = `k106-${crypto.randomUUID()}@test.local`;
let token = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K106 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, owner]);
  token = await new SignJWT({ sub: owner, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_invitations WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [owner]);
  } finally { await pool.end(); }
});

it('the response after a failed invite email describes what actually survived', async () => {
  const invitations = (await import('../../pages/api/invitations/index')).default;
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = { email: invitee, role: 'viewer' };
  req.query = {};
  req.url = '/api/invitations';
  const result = response();
  await invitations(req as never, result.res);

  const rows = await pool.query(
    'SELECT gotrue_user_id, email_sent_at, email_error FROM company_invitations WHERE company_id=$1 AND email=$2',
    [company, invitee]);
  const body = result.state.body as { data?: { emailSent?: boolean; emailError?: string } };
  // 201, not 502: withAuth ROLLBACKs on any status >= 500, so a 502 discarded
  // the invitation row, its gotrue_user_id and the email_error just written,
  // and then told the caller to resend something that no longer existed.
  expect({
    status: result.state.statusCode,
    rowsPersisted: rows.rows.length,
    emailSent: body.data?.emailSent,
    emailError: body.data?.emailError,
  }).toEqual({ status: 201, rowsPersisted: 1, emailSent: false, emailError: 'SMTP unreachable' });
  // The row is diagnosable afterwards: the failure is on it and it is not
  // marked as sent, so the Users list shows a real pending invitation.
  expect(rows.rows[0].gotrue_user_id).toBe(gotrueUserId);
  expect(rows.rows[0].email_sent_at).toBeNull();
  expect(rows.rows[0].email_error).toBe('SMTP unreachable');
});

it('a successful send reports emailSent true and stamps the row', async () => {
  const emailService = await import('@/modules/accounting/services/core/emailService');
  vi.mocked(emailService.sendEmail).mockResolvedValueOnce(undefined as never);
  const invitations = (await import('../../pages/api/invitations/index')).default;
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = { email: invitee, role: 'manager' };
  req.query = {};
  req.url = '/api/invitations';
  const result = response();
  await invitations(req as never, result.res);

  const body = result.state.body as { data?: { emailSent?: boolean } };
  expect({ status: result.state.statusCode, emailSent: body.data?.emailSent })
    .toEqual({ status: 201, emailSent: true });
  const rows = await pool.query(
    'SELECT email_sent_at, email_error FROM company_invitations WHERE company_id=$1 AND email=$2',
    [company, invitee]);
  expect(rows.rows[0].email_sent_at).not.toBeNull();
  expect(rows.rows[0].email_error).toBeNull();
});
