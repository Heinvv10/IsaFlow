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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  invitation: null as null | Record<string, unknown>,
  queries: [] as { text: string; params: unknown[] }[],
  establishedIds: new Set<string>(),
  invitationStillPending: true,
  findUserByEmail: vi.fn(),
  adminCreateUser: vi.fn(),
  adminUpdateUser: vi.fn(),
  signIn: vi.fn(),
  listFactors: vi.fn(),
  adminListUserFactors: vi.fn(),
  setAuthCookies: vi.fn(),
}));

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: logger, apiLogger: logger };
});
vi.mock('@/lib/auth/withInviteToken', () => ({
  withInviteToken: (handler: (q: NextApiRequest, s: NextApiResponse) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) => { (req as unknown as { inviteTokenHash: string }).inviteTokenHash = 'digest'; return handler(req, res); },
}));
vi.mock('@/lib/rateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
  chargeRateLimit: vi.fn(async () => ({ admitted: true, windowStart: 'w' })),
  refundRateLimit: vi.fn(async () => undefined),
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => (h.invitation ? [h.invitation] : [])),
}));
vi.mock('@/lib/auth/gotrue', () => ({
  findUserByEmail: h.findUserByEmail,
  adminCreateUser: h.adminCreateUser,
  adminUpdateUser: h.adminUpdateUser,
  signIn: h.signIn,
}));
vi.mock('@/lib/auth/gotrue-mfa', async (orig) => ({
  ...(await orig<object>()),
  listFactors: h.listFactors,
  adminListUserFactors: h.adminListUserFactors,
}));
vi.mock('@/lib/auth/cookies', () => ({ setAuthCookies: h.setAuthCookies, setActiveCompanyCookie: vi.fn() }));
vi.mock('@/lib/auth/liveCompanies', () => ({
  isLiveCompanyForUser: vi.fn(async () => true),
  pickInitialCompanyId: vi.fn(async () => null),
}));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminPool: () => ({
    connect: async () => ({
      async query(text: string, params: unknown[] = []) {
        h.queries.push({ text, params });
        if (/FROM users WHERE id/.test(text)) {
          const hit = h.establishedIds.has(params[0] as string);
          return { rows: hit ? [{ id: params[0] }] : [], rowCount: hit ? 1 : 0 };
        }
        if (/SET accepted_at = now\(\)/.test(text)) return { rows: [], rowCount: h.invitationStillPending ? 1 : 0 };
        return { rows: [], rowCount: 1 };
      },
      release() { /* pooled */ },
    }),
  }),
}));

const { default: acceptInvite } = await import('../../../pages/api/invitations/[token]/accept');

async function accept(password: string): Promise<{ status: number; body: { error?: { code?: string } } }> {
  const out = { status: 200, body: {} as { error?: { code?: string } } };
  const res = {
    setHeader() { return this; },
    getHeader() { return undefined; },
    status(code: number) { out.status = code; return this; },
    json(b: { error?: { code?: string } }) { out.body = b; return this; },
  } as unknown as NextApiResponse;
  const req = {
    method: 'POST', url: '/api/invitations/raw/accept', query: { token: 'raw-invite-token' },
    body: { password, firstName: 'New', lastName: 'Member' }, headers: {}, socket: {},
  } as unknown as NextApiRequest;
  await (acceptInvite as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res);
  return out;
}

const tokens = (userId: string) => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: userId } });
const ran = (re: RegExp) => h.queries.some((q) => re.test(q.text));

beforeEach(() => {
  vi.clearAllMocks();
  h.queries.length = 0;
  h.establishedIds.clear();
  h.invitationStillPending = true;
  h.findUserByEmail.mockResolvedValue(null);
  h.listFactors.mockResolvedValue({ totp: [] });
  h.adminListUserFactors.mockResolvedValue([]);
  h.invitation = { id: 'inv-1', email: 'invitee@example.test', role: 'viewer', company_id: 'co-1', gotrue_user_id: null };
});

describe('accepting an invitation that names no account', () => {
  it('a new address gets a login for the invited address, a password, and the inviting company', async () => {
    h.adminCreateUser.mockResolvedValue({ id: 'gt-new', email: 'invitee@example.test' });
    h.signIn.mockResolvedValue(tokens('gt-new'));

    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.findUserByEmail).toHaveBeenCalledWith('invitee@example.test');
    expect(h.adminCreateUser).toHaveBeenCalledWith({ email: 'invitee@example.test', email_confirm: true });
    expect(h.adminUpdateUser).toHaveBeenCalledWith('gt-new', expect.objectContaining({ password: 'a-new-password-1' }));
    expect(h.queries.find((q) => /INSERT INTO company_users/.test(q.text))?.params).toEqual(['co-1', 'gt-new', 'viewer']);
    expect(ran(/SET accepted_at = now\(\)/)).toBe(true);
    expect(ran(/^COMMIT$/)).toBe(true);
    // Never written back: revoke deletes a stored account that has no memberships.
    expect(ran(/SET gotrue_user_id/)).toBe(false);
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
