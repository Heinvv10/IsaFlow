/**
 * Invitations sent from Settings -> User Access (userInvitationService) carry
 * no gotrue_user_id. POST /api/invitations/<t>/accept used to refuse them
 * (410), which left a brand-new invitee no way to join except the self-serve
 * signup, and that creates a second company. Accept now finds the invited
 * address's account, or creates one for a strong enough password, and runs the
 * same guards as before. Also pinned here: an account with a verified second
 * factor gets no session from a password alone, and an invitation revoked
 * mid-accept commits nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { accept, h, ran, tokens } from './inviteAccept.harness';

describe('accepting an invitation that names no account', () => {
  it('a new address gets a login for the invited address, a password, and the inviting company', async () => {
    h.adminCreateUser.mockResolvedValue({ id: 'gt-new', email: 'invitee@example.test' });
    h.signIn.mockResolvedValue(tokens('gt-new'));

    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.findUserByEmail).toHaveBeenCalledWith('invitee@example.test');
    expect(h.adminCreateUser).toHaveBeenCalledWith({ email: 'invitee@example.test', email_confirm: true, user_metadata: { invite_id: 'inv-1' } });
    expect(h.adminUpdateUser).toHaveBeenCalledWith('gt-new', expect.objectContaining({ password: 'a-new-password-1' }));
    expect(h.queries.find((q) => /INSERT INTO company_users/.test(q.text))?.params).toEqual(['co-1', 'gt-new', 'viewer']);
    expect(ran(/SET accepted_at = now\(\)/)).toBe(true);
    expect(ran(/^COMMIT$/)).toBe(true);
    // Never written back: revoke deletes a stored account that has no memberships.
    expect(ran(/SET gotrue_user_id/)).toBe(false);
    // A member of an existing company skips the new-company onboarding wizard (browser proof 2026-10-27).
    expect(h.queries.find((q) => /INSERT INTO users/.test(q.text))?.text).toMatch(/onboarding_completed = COALESCE\(users\.onboarding_completed, true\)/);
    expect(h.setOnboardingDoneCookie).toHaveBeenCalled();
    // The accepter now holds a session: that is a sign-in (audit 2026-11-14, 1.1). Once, for the verified account.
    expect(h.recordSignInSafely).toHaveBeenCalledTimes(1);
    expect(h.recordSignInSafely).toHaveBeenCalledWith('gt-new', 'invite-accept');
  });

  it('the response does not wait for the sign-in stamp (a hung stamp cannot hold the accept)', async () => {
    h.adminCreateUser.mockResolvedValue({ id: 'gt-new', email: 'invitee@example.test' });
    h.signIn.mockResolvedValue(tokens('gt-new'));
    h.recordSignInSafely.mockReturnValueOnce(new Promise(() => undefined));

    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.recordSignInSafely).toHaveBeenCalledTimes(1);
  });

  it('a weak password for an address with no login creates nothing', async () => {
    const { status, body } = await accept('short');

    expect(status).toBe(400);
    expect(body.error?.code).toBe('WEAK_PASSWORD');
    expect(h.adminCreateUser).not.toHaveBeenCalled();
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
  });

  it('an existing login is found, never created over, and must give its own password', async () => {
    h.findUserByEmail.mockResolvedValue({ id: 'gt-existing', email: 'invitee@example.test' });
    h.establishedIds.add('gt-existing');
    h.signIn.mockRejectedValue(new Error('invalid_grant'));

    const { status, body } = await accept('a-guess-123456');

    expect(status).toBe(401);
    expect(body.error?.code).toBe('SIGN_IN_REQUIRED');
    expect(h.adminCreateUser).not.toHaveBeenCalled();
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
    expect(ran(/INSERT INTO company_users/)).toBe(false);
    expect(h.recordSignInSafely).not.toHaveBeenCalled();
  });

  it('an invitation that already names its account is not looked up', async () => {
    h.invitation = { ...h.invitation!, gotrue_user_id: 'gt-from-invite' };
    h.signIn.mockResolvedValue(tokens('gt-from-invite'));

    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.findUserByEmail).not.toHaveBeenCalled();
    expect(h.adminCreateUser).not.toHaveBeenCalled();
  });
});

describe('an existing account with a verified second factor', () => {
  beforeEach(() => {
    h.findUserByEmail.mockResolvedValue({ id: 'gt-2fa', email: 'invitee@example.test' });
    h.establishedIds.add('gt-2fa');
    h.signIn.mockResolvedValue(tokens('gt-2fa'));
  });

  it('gets no session and no membership from its password alone: 401 MFA_REQUIRED', async () => {
    h.listFactors.mockResolvedValue({ totp: [{ id: 'f1', status: 'verified', factor_type: 'totp' }] });

    const { status, body } = await accept('the-right-password');

    expect(status).toBe(401);
    expect(body.error?.code).toBe('MFA_REQUIRED');
    expect(h.setAuthCookies).not.toHaveBeenCalled();
    expect(ran(/INSERT INTO company_users/)).toBe(false);
    expect(h.recordSignInSafely).not.toHaveBeenCalled();
  });

  it('an unverified factor does not count', async () => {
    h.listFactors.mockResolvedValue({ totp: [{ id: 'f1', status: 'unverified', factor_type: 'totp' }] });

    expect((await accept('the-right-password')).status).toBe(200);
    expect(h.setAuthCookies).toHaveBeenCalled();
  });

  it('factors that cannot be read fail closed: no session', async () => {
    const { AuthUpstreamUnavailableError } = await import('@/lib/auth/authUpstream');
    h.listFactors.mockRejectedValue(new AuthUpstreamUnavailableError('gotrue /user unavailable: HTTP 503'));

    expect((await accept('the-right-password')).status).toBe(503);
    expect(h.setAuthCookies).not.toHaveBeenCalled();
    expect(ran(/INSERT INTO company_users/)).toBe(false);
  });

  it('a GoTrue refusal reading the factors is 503 AUTH_UNAVAILABLE, as login answers it, never a pass', async () => {
    const { GotrueMfaError } = await vi.importActual<typeof import('@/lib/auth/gotrue-mfa')>('@/lib/auth/gotrue-mfa');
    h.listFactors.mockRejectedValue(new GotrueMfaError(401, 'bad jwt', null));

    const { status, body } = await accept('the-right-password');

    expect(status).toBe(503);
    expect(body.error?.code).toBe('AUTH_UNAVAILABLE');
    expect(h.setAuthCookies).not.toHaveBeenCalled();
  });
});

describe('an existing GoTrue account with no IsaFlow profile row', () => {
  beforeEach(() => {
    h.findUserByEmail.mockResolvedValue({ id: 'gt-orphan', email: 'invitee@example.test' });
    h.signIn.mockResolvedValue(tokens('gt-orphan'));
  });

  it('with a verified second factor: refused before its password is touched', async () => {
    h.adminListUserFactors.mockResolvedValue([{ id: 'f1', status: 'verified', factor_type: 'totp' }]);

    const { status, body } = await accept('attacker-chosen-pw-1');

    expect(status).toBe(401);
    expect(body.error?.code).toBe('MFA_REQUIRED');
    expect(h.adminListUserFactors).toHaveBeenCalledWith('gt-orphan');
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
    expect(h.signIn).not.toHaveBeenCalled();
    expect(h.setAuthCookies).not.toHaveBeenCalled();
  });

  it('a weak password for it is refused before anything is set', async () => {
    const { status, body } = await accept('short');

    expect(status).toBe(400);
    expect(body.error?.code).toBe('WEAK_PASSWORD');
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
    expect(h.signIn).not.toHaveBeenCalled();
  });

  it('a sign-in that answers as a different account is refused (409), with no membership', async () => {
    h.signIn.mockResolvedValue(tokens('gt-someone-else'));

    const { status, body } = await accept('a-new-password-1');

    expect(status).toBe(409);
    expect(body.error?.code).toBe('IDENTITY_MISMATCH');
    expect(ran(/INSERT INTO company_users/)).toBe(false);
    expect(h.setAuthCookies).not.toHaveBeenCalled();
  });

  it('without one: the invitee sets the password and joins, as a pending signup always could', async () => {
    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.adminUpdateUser).toHaveBeenCalledWith('gt-orphan', expect.objectContaining({ password: 'a-new-password-1' }));
  });

  // Review round 3: a lookup that misses (or a race) and a create that 422s
  // hands back an EXISTING account; "just created" cannot be trusted to skip this.
  it('an account adminCreateUser answered from a 422 is checked too', async () => {
    h.findUserByEmail.mockResolvedValue(null);
    h.adminCreateUser.mockResolvedValue({ id: 'gt-2fa', email: 'invitee@example.test' });
    h.adminListUserFactors.mockResolvedValue([{ id: 'f1', status: 'verified', factor_type: 'totp' }]);

    const { status, body } = await accept('attacker-chosen-pw-1');

    expect(status).toBe(401);
    expect(body.error?.code).toBe('MFA_REQUIRED');
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
  });
});

// R7-1 security review: a pin (Settings since R7-1, an adminCreateUser 422) can name an account that already held
// the address. No password is ever set on an account no invitation created, nor on one that left the address.
