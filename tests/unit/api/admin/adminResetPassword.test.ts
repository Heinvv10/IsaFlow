/**
 * R-032 M2: the admin "Reset password" action emails the user OUR single-use
 * reset link and returns no link at all.
 *
 * It used to call GoTrue's admin generate_link('recovery') and hand the
 * action_link back in the JSON response. generate_link sends nothing, so the
 * user received no email, and the only copy of a working recovery session for
 * the user sat in the admin's response. The reset now goes through the same
 * self-owned flow as forgot-password: a token from passwordResetService, emailed
 * to /reset-password#token=<token>. sendEmail is mocked — no real email.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const calls: string[] = [];
const target = { id: '00000000-0000-4000-8000-00000000a032', email: 'target@example.com', role: 'admin' };
const fx = vi.hoisted(() => ({
  userRow: null as null | { id: string; email: string; role: string },
  send: { success: true } as { success: boolean; error?: string },
}));

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => (fx.userRow ? [fx.userRow] : [])) }));
const logAdminAction = vi.fn(async () => { calls.push('audit'); });
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: (...a: unknown[]) => logAdminAction(...(a as [])) }));
const issuePasswordResetToken = vi.fn(async (userId: string) => {
  calls.push(`token:${userId}`);
  return { token: 'ours-single-use-token', tokenHash: 'ours-hash', expiresAt: new Date(Date.now() + 3_600_000) };
});
const supersedePasswordResetTokens = vi.fn(async (_userId: string, _keep: string) => { calls.push('supersede'); });
const withdrawPasswordResetToken = vi.fn(async (_hash: string) => { calls.push('withdraw'); });
vi.mock('@/lib/auth/passwordResetService', () => ({
  issuePasswordResetToken: (userId: string) => issuePasswordResetToken(userId),
  supersedePasswordResetTokens: (u: string, k: string) => supersedePasswordResetTokens(u, k),
  withdrawPasswordResetToken: (h: string) => withdrawPasswordResetToken(h),
}));
const sendEmail = vi.fn(async (opts: { to: string }) => { calls.push(`send:${opts.to}`); return fx.send; });
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendEmail: (opts: { to: string }) => sendEmail(opts),
}));
const generateLink = vi.fn();
vi.mock('@/lib/auth/gotrue-admin-link', () => ({ generateLink: (...a: unknown[]) => generateLink(...a) }));

import handler from '../../../../pages/api/admin/users/[id]/reset-password';
import { log } from '@/lib/logger';

function call() {
  const req = { method: 'POST', query: { id: target.id }, user: { id: 'platform-admin' }, headers: {},
    socket: { remoteAddress: '127.0.0.1' } } as unknown as NextApiRequest;
  const state = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(body: unknown) { state.body = body; return res; },
    setHeader() { return res; },
  } as unknown as NextApiResponse;
  return (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res).then(() => state);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  fx.userRow = target;
  fx.send = { success: true };
});

describe('POST /api/admin/users/[id]/reset-password', () => {
  it('returns no link — nothing in the response can open the account', async () => {
    const state = await call();
    expect(state.statusCode).toBe(200);
    const text = JSON.stringify(state.body);
    expect(text).not.toMatch(/link|token|verify|recovery/i);
    expect((state.body as { data?: { message?: string } }).data?.message).toBe('Password reset email sent');
  });

  it('makes no GoTrue recovery call', async () => {
    await call();
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('emails one reset link, built on our own token, to the target', async () => {
    await call();
    expect(issuePasswordResetToken).toHaveBeenCalledWith(target.id);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0]![0] as { to: string; html: string };
    expect(sent.to).toBe(target.email);
    expect(sent.html).toContain('/reset-password#token=ours-single-use-token');
  });

  it('writes the audit row before the email goes out', async () => {
    await call();
    expect(calls).toEqual(['audit', `token:${target.id}`, `send:${target.email}`, 'supersede']);
    expect(supersedePasswordResetTokens).toHaveBeenCalledWith(target.id, 'ours-hash');
  });

  it('says so when the email could not be sent — never "sent"', async () => {
    fx.send = { success: false, error: 'SMTP not configured' };
    const state = await call();
    expect(state.statusCode).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(state.body)).not.toMatch(/email sent/i);
    expect(JSON.stringify(state.body)).toMatch(/could not be sent/i);
    // R-032 re-check: the unsent link is withdrawn and the user's outstanding links are left alone.
    expect(withdrawPasswordResetToken).toHaveBeenCalledWith('ours-hash');
    expect(supersedePasswordResetTokens).not.toHaveBeenCalled();
  });

  it('reports success when the email went out but retiring older links failed (R-032 LOW-1)', async () => {
    supersedePasswordResetTokens.mockImplementationOnce(async () => { throw new Error('connection reset'); });
    const state = await call();
    expect(state.statusCode).toBe(200);
    expect((state.body as { data?: { message?: string } }).data?.message).toBe('Password reset email sent');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(log.error).mock.calls
      .filter(([message]) => String(message).includes('superseding older links failed'));
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toMatchObject({ userId: target.id });
    expect(JSON.stringify(logged)).not.toContain('ours-single-use-token');
  });

  it('still refuses to reset a super_admin, and emails nobody', async () => {
    fx.userRow = { ...target, role: 'super_admin' };
    const state = await call();
    expect(state.statusCode).toBeGreaterThanOrEqual(400);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(issuePasswordResetToken).not.toHaveBeenCalled();
  });
});
