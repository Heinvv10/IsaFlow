/**
 * Shared harness for the POST /api/invitations/<t>/accept unit suites (inviteAcceptUnlinkedAccount*.test.ts):
 * every collaborator mocked, `h` holds their state, `accept(password)` drives the route. Import it FIRST in a test
 * file: its vi.mock calls must register before the route is imported.
 */
import { vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

export const h = {
  invitation: null as null | Record<string, unknown>,
  queries: [] as { text: string; params: unknown[] }[],
  establishedIds: new Set<string>(),
  invitationStillPending: true,
  findUserByEmail: vi.fn(),
  adminGetUser: vi.fn(),
  adminCreateUser: vi.fn(),
  adminUpdateUser: vi.fn(),
  signIn: vi.fn(),
  listFactors: vi.fn(),
  adminListUserFactors: vi.fn(),
  setAuthCookies: vi.fn(),
  setOnboardingDoneCookie: vi.fn(),
  recordSignInSafely: vi.fn(),
};

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
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: h.adminGetUser }));
vi.mock('@/lib/auth/gotrue-mfa', async (orig) => ({
  ...(await orig<object>()),
  listFactors: h.listFactors,
  adminListUserFactors: h.adminListUserFactors,
}));
vi.mock('@/lib/auth/cookies', () => ({
  setAuthCookies: h.setAuthCookies, setActiveCompanyCookie: vi.fn(), setOnboardingDoneCookie: h.setOnboardingDoneCookie,
}));
vi.mock('@/lib/auth/recordSignIn', () => ({ recordSignInSafely: h.recordSignInSafely }));
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
        // upsertInviteeProfile's case-insensitive address check: no other row holds it.
        if (/lower\(o\.email\) = lower\(\$2\)/.test(text)) return { rows: [], rowCount: 0 };
        // As Postgres answers: an accepted-meanwhile row still matches an UPDATE without
        // `AND accepted_at IS NULL`, so only the predicate makes the race visible.
        if (/SET accepted_at = now\(\)/.test(text)) {
          return { rows: [], rowCount: h.invitationStillPending || !/AND accepted_at IS NULL/.test(text) ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      },
      release() { /* pooled */ },
    }),
  }),
}));

const { default: acceptInvite } = await import('../../../pages/api/invitations/[token]/accept');

export async function accept(password: string): Promise<{ status: number; body: { error?: { code?: string } } }> {
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

export const tokens = (userId: string) => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: userId } });
export const ran = (re: RegExp) => h.queries.some((q) => re.test(q.text));

beforeEach(() => {
  vi.clearAllMocks();
  h.queries.length = 0;
  h.establishedIds.clear();
  h.invitationStillPending = true;
  h.findUserByEmail.mockResolvedValue(null);
  // By default every account holds the invited address and was created for this invitation (invite_id).
  h.adminGetUser.mockImplementation(async (id: string) => ({ id, email: 'invitee@example.test', user_metadata: { invite_id: 'inv-1' } }));
  h.listFactors.mockResolvedValue({ totp: [] });
  h.adminListUserFactors.mockResolvedValue([]);
  h.invitation = { id: 'inv-1', email: 'invitee@example.test', role: 'viewer', company_id: 'co-1', gotrue_user_id: null };
});

