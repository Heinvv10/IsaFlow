/**
 * POST /api/invitations/<t>/accept, continued from inviteAcceptUnlinkedAccount.test.ts (split for size): an account
 * the invitation did not create, an invitation revoked mid-accept, a GoTrue outage while resolving the account, and
 * an invited company that no longer exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { accept, h, ran, tokens } from './inviteAccept.harness';

describe('an account the invitation did not create', () => {
  beforeEach(() => {
    h.invitation = { ...h.invitation!, gotrue_user_id: 'gt-held' };
    h.signIn.mockResolvedValue(tokens('gt-held'));
  });

  it.each([
    ['confirmed, created by no invitation', {}, undefined],
    ["a deleted user's login (signed in before)", {}, '2026-11-01T00:00:00Z'],
    ['created by this invitation, but signed in since (B3)', { invite_id: 'inv-1' }, '2026-11-01T00:00:00Z'],
    ['created by another invitation, but signed in since (it has an owner)', { invite_id: 'inv-other' }, '2026-11-01T00:00:00Z'],
  ])('%s: never gets a password set; a wrong password is 401, nothing written', async (_, meta, lastSignIn) => {
    h.adminGetUser.mockResolvedValue({ id: 'gt-held', email: 'invitee@example.test', user_metadata: meta,
      last_sign_in_at: lastSignIn, email_confirmed_at: '2026-10-01T00:00:00Z' });
    h.signIn.mockRejectedValue(new Error('invalid_grant'));
    const { status, body } = await accept('attacker-chosen-pw-1');
    expect([status, body.error?.code]).toEqual([401, 'SIGN_IN_REQUIRED']);
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
    expect(ran(/INSERT INTO company_users/)).toBe(false);
  });

  it('with its own password: joins as that account, its password untouched', async () => {
    h.adminGetUser.mockResolvedValue({ id: 'gt-held', email: 'invitee@example.test', user_metadata: {}, email_confirmed_at: '2026-10-01T00:00:00Z' });
    expect((await accept('their-own-password')).status).toBe(200);
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
    expect(h.queries.find((q) => /INSERT INTO company_users/.test(q.text))?.params).toEqual(['co-1', 'gt-held', 'viewer']);
  });

  it('a placeholder another invitation created, never signed in: the invitee sets its password', async () => {
    h.adminGetUser.mockResolvedValue({ id: 'gt-held', email: 'invitee@example.test', user_metadata: { invite_id: 'inv-other' }, last_sign_in_at: null });
    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.adminUpdateUser).toHaveBeenCalledWith('gt-held', expect.objectContaining({ password: 'a-new-password-1' }));
  });

  it('an unconfirmed signup or squatter at the address, never signed in (B4): the invitee sets its password', async () => {
    h.adminGetUser.mockResolvedValue({ id: 'gt-held', email: 'invitee@example.test', user_metadata: {}, last_sign_in_at: null });
    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.adminUpdateUser).toHaveBeenCalledWith('gt-held', expect.objectContaining({ password: 'a-new-password-1', email_confirm: true }));
  });

  it.each([
    ['its login email is no longer the invitation\'s', { id: 'gt-held', email: 'moved@example.test', user_metadata: { invite_id: 'inv-1' } }],
    ['GoTrue has no such account', null],
  ])('%s: 409 IDENTITY_MISMATCH before any password write or sign-in', async (_, account) => {
    h.adminGetUser.mockResolvedValue(account);
    const { status, body } = await accept('a-new-password-1');
    expect([status, body.error?.code]).toEqual([409, 'IDENTITY_MISMATCH']);
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
    expect(h.signIn).not.toHaveBeenCalled();
  });
});

describe('an invitation revoked or accepted while this accept was running', () => {
  it('commits nothing and answers 410', async () => {
    h.adminCreateUser.mockResolvedValue({ id: 'gt-new', email: 'invitee@example.test' });
    h.signIn.mockResolvedValue(tokens('gt-new'));
    h.invitationStillPending = false;

    const { status, body } = await accept('a-new-password-1');

    expect(status).toBe(410);
    expect(body.error?.code).toBe('INVALID_OR_EXPIRED');
    expect(ran(/^COMMIT$/)).toBe(false);
    expect(ran(/^ROLLBACK$/)).toBe(true);
    expect(h.setAuthCookies).not.toHaveBeenCalled();
  });
});

describe('a GoTrue outage while resolving the account (D9)', () => {
  it('answers 503 AUTH_UNAVAILABLE and refunds the attempt', async () => {
    const { AuthUpstreamUnavailableError } = await import('@/lib/auth/authUpstream');
    const { refundRateLimit } = await import('@/lib/rateLimit');
    h.findUserByEmail.mockRejectedValue(new AuthUpstreamUnavailableError('gotrue adminGetUserByEmail unavailable: HTTP 503'));

    const { status, body } = await accept('a-new-password-1');

    expect(status).toBe(503);
    expect(body.error?.code).toBe('AUTH_UNAVAILABLE');
    expect(h.adminCreateUser).not.toHaveBeenCalled();
    expect(refundRateLimit).toHaveBeenCalled();
  });

  it('the real lookups classify a 5xx as an outage, not a plain failure', async () => {
    const real = await vi.importActual<typeof import('@/lib/auth/gotrue')>('@/lib/auth/gotrue');
    const { AuthUpstreamUnavailableError } = await import('@/lib/auth/authUpstream');
    vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-role');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":503}', { status: 503 })));
    try {
      await expect(real.findUserByEmail('invitee@example.test')).rejects.toBeInstanceOf(AuthUpstreamUnavailableError);
      await expect(real.adminCreateUser({ email: 'invitee@example.test', email_confirm: true }))
        .rejects.toBeInstanceOf(AuthUpstreamUnavailableError);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it('the real lookup answers null, not a throw, for an address with no account', async () => {
    const real = await vi.importActual<typeof import('@/lib/auth/gotrue')>('@/lib/auth/gotrue');
    vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-role');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ users: [{ id: 'x', email: 'invitee@example.test.other' }] }), { status: 200 })));
    try {
      expect(await real.findUserByEmail('invitee@example.test')).toBeNull();
      await expect(real.adminGetUserByEmail('invitee@example.test')).rejects.toThrow(/no gotrue user/);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
});

describe('an invited company that no longer exists', () => {
  it('sets no onboarding-done cookie when there is no company to land in', async () => {
    const live = await import('@/lib/auth/liveCompanies');
    vi.mocked(live.isLiveCompanyForUser).mockResolvedValueOnce(false);
    vi.mocked(live.pickInitialCompanyId).mockResolvedValueOnce(null);
    h.adminCreateUser.mockResolvedValue({ id: 'gt-new', email: 'invitee@example.test' });
    h.signIn.mockResolvedValue(tokens('gt-new'));

    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.setOnboardingDoneCookie).not.toHaveBeenCalled();
  });
});
