/**
 * Invitations sent from Settings -> User Access (userInvitationService) carry
 * no gotrue_user_id. POST /api/invitations/<t>/accept used to refuse them
 * (410), which left a brand-new invitee no way to join except the self-serve
 * signup, and that creates a second company. Accept now resolves the account
 * for the invited address first, then runs the same guards as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  invitation: null as null | Record<string, unknown>,
  queries: [] as { text: string; params: unknown[] }[],
  establishedIds: new Set<string>(),
  storedAccountId: null as string | null,
  adminCreateUser: vi.fn(),
  adminUpdateUser: vi.fn(),
  signIn: vi.fn(),
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
  adminCreateUser: h.adminCreateUser,
  adminUpdateUser: h.adminUpdateUser,
  signIn: h.signIn,
}));
vi.mock('@/lib/auth/cookies', () => ({ setAuthCookies: vi.fn(), setActiveCompanyCookie: vi.fn() }));
vi.mock('@/lib/auth/liveCompanies', () => ({
  isLiveCompanyForUser: vi.fn(async () => true),
  pickInitialCompanyId: vi.fn(async () => null),
}));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminPool: () => ({
    connect: async () => ({
      async query(text: string, params: unknown[] = []) {
        h.queries.push({ text, params });
        if (/^\s*UPDATE company_invitations SET gotrue_user_id/.test(text)) {
          h.storedAccountId ??= params[1] as string;
          return { rows: [{ gotrue_user_id: h.storedAccountId }], rowCount: 1 };
        }
        if (/FROM users WHERE id/.test(text)) {
          const hit = h.establishedIds.has(params[0] as string);
          return { rows: hit ? [{ id: params[0] }] : [], rowCount: hit ? 1 : 0 };
        }
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

beforeEach(() => {
  vi.clearAllMocks();
  h.queries.length = 0;
  h.establishedIds.clear();
  h.storedAccountId = null;
  h.invitation = { id: 'inv-1', email: 'invitee@example.test', role: 'viewer', company_id: 'co-1', gotrue_user_id: null };
});

describe('accepting an invitation that has no account yet', () => {
  it('creates the login for the invited address, links it, sets the password and joins the inviting company', async () => {
    h.adminCreateUser.mockResolvedValue({ id: 'gt-new', email: 'invitee@example.test' });
    h.signIn.mockResolvedValue(tokens('gt-new'));

    const { status } = await accept('a-new-password-1');

    expect(status).toBe(200);
    expect(h.adminCreateUser).toHaveBeenCalledWith({ email: 'invitee@example.test', email_confirm: true });
    expect(h.queries.some((q) => /SET gotrue_user_id/.test(q.text) && q.params[1] === 'gt-new')).toBe(true);
    expect(h.adminUpdateUser).toHaveBeenCalledWith('gt-new', expect.objectContaining({ password: 'a-new-password-1' }));
    const membership = h.queries.find((q) => /INSERT INTO company_users/.test(q.text));
    expect(membership?.params).toEqual(['co-1', 'gt-new', 'viewer']);
    expect(h.queries.some((q) => /SET accepted_at = now\(\)/.test(q.text))).toBe(true);
  });

  it('an address that already has a login keeps its password: the typed one must match it', async () => {
    h.adminCreateUser.mockResolvedValue({ id: 'gt-existing', email: 'invitee@example.test' });
    h.establishedIds.add('gt-existing');
    h.signIn.mockRejectedValue(new Error('invalid_grant'));

    const { status, body } = await accept('a-guess-123456');

    expect(status).toBe(401);
    expect(body.error?.code).toBe('SIGN_IN_REQUIRED');
    expect(h.adminUpdateUser).not.toHaveBeenCalled();
    expect(h.queries.some((q) => /INSERT INTO company_users/.test(q.text))).toBe(false);
  });

  it('an account already linked by a concurrent accept wins over the one just looked up', async () => {
    h.storedAccountId = 'gt-linked-first';
    h.adminCreateUser.mockResolvedValue({ id: 'gt-looked-up', email: 'invitee@example.test' });
    h.signIn.mockResolvedValue(tokens('gt-linked-first'));

    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.adminUpdateUser).toHaveBeenCalledWith('gt-linked-first', expect.anything());
  });

  it('an invitation that already names its account is not looked up again', async () => {
    h.invitation = { ...h.invitation!, gotrue_user_id: 'gt-from-invite' };
    h.signIn.mockResolvedValue(tokens('gt-from-invite'));

    expect((await accept('a-new-password-1')).status).toBe(200);
    expect(h.adminCreateUser).not.toHaveBeenCalled();
    expect(h.queries.some((q) => /SET gotrue_user_id/.test(q.text))).toBe(false);
  });
});

describe('a GoTrue outage while resolving the account (D9)', () => {
  it('answers 503 AUTH_UNAVAILABLE, links nothing and refunds the attempt', async () => {
    const { AuthUpstreamUnavailableError } = await import('@/lib/auth/authUpstream');
    const { refundRateLimit } = await import('@/lib/rateLimit');
    h.adminCreateUser.mockRejectedValue(new AuthUpstreamUnavailableError('gotrue adminCreateUser unavailable: HTTP 503'));

    const { status, body } = await accept('a-new-password-1');

    expect(status).toBe(503);
    expect(body.error?.code).toBe('AUTH_UNAVAILABLE');
    expect(h.queries.some((q) => /SET gotrue_user_id/.test(q.text))).toBe(false);
    expect(refundRateLimit).toHaveBeenCalled();
  });

  it('the real adminCreateUser classifies a 5xx as an outage, not a plain failure', async () => {
    const real = await vi.importActual<typeof import('@/lib/auth/gotrue')>('@/lib/auth/gotrue');
    const { AuthUpstreamUnavailableError } = await import('@/lib/auth/authUpstream');
    vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-role');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":503}', { status: 503 })));
    try {
      await expect(real.adminCreateUser({ email: 'invitee@example.test', email_confirm: true }))
        .rejects.toBeInstanceOf(AuthUpstreamUnavailableError);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
});
