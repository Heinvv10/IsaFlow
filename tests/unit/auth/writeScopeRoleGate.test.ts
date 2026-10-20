/**
 * Audit 2026-10-18 S-01 — a token's write scopes answer to the minting user's role in the company.
 * A viewer could mint a PAT with write:post, or tick write:* on the OAuth consent screen. The PAT route
 * refuses a write scope for a role that cannot write (the user asked for it explicitly); consent grants
 * the read scopes and drops the write ones (an OAuth client asks for everything, and a viewer must still
 * be able to connect read-only). The role is the one in the TARGET company of the consent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlFn, withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/oauth', async () => ({
  OAUTH_SCOPES: (await import('@/lib/auth/oauthScopes')).OAUTH_SCOPES,
  getOauthAppByClientId: vi.fn(),
  createAuthorisationCode: vi.fn(),
}));
vi.mock('@/lib/auth/personalAccessTokens', async () => ({
  PAT_SCOPES: (await import('@/lib/auth/patScopes')).PAT_SCOPES,
  createPat: vi.fn(),
  listPats: vi.fn(),
}));

import { getOauthAppByClientId, createAuthorisationCode } from '@/lib/auth/oauth';
import { createPat } from '@/lib/auth/personalAccessTokens';
import { scopesRoleMayNotHold } from '@/lib/auth/writeRoles';
import consentHandler from '../../../pages/api/oauth/consent';
import patHandler from '../../../pages/api/auth/personal-tokens/index';
import { resetSqlMock, mockSqlOnce } from './helpers';

type H = (req: unknown, res: unknown) => Promise<void>;
const HOME = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-9999-9999-999999999999';

interface FakeRes { statusCode: number; body?: { success: boolean; error?: { code: string; message?: string } } }
function makeRes(): NextApiResponse & FakeRes {
  const res = {
    statusCode: 200, body: undefined as FakeRes['body'],
    setHeader() { return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: FakeRes['body']) { res.body = b; return res; },
  };
  return res as unknown as NextApiResponse & FakeRes;
}
const patReq = (companyRole: string, scopes: string[]) => ({
  method: 'POST', headers: {}, user: { id: 'u-1' }, companyId: HOME, companyRole, body: { name: 'agent', scopes },
});
const consentReq = (companyRole: string, extra: Record<string, unknown> = {}) => ({
  method: 'POST', headers: {}, url: '/api/oauth/consent', user: { id: 'u-1', claims: {} }, companyId: HOME, companyRole,
  body: {
    clientId: 'client_abc', redirectUri: 'https://claude.ai/cb', codeChallenge: 'c', codeChallengeMethod: 'S256',
    scopes: ['read:reports', 'write:invoices', 'write:post'], optInConfirmed: ['write:post'], ...extra,
  },
});
const granted = () => vi.mocked(createAuthorisationCode).mock.calls[0]![0].scopes;

beforeEach(() => {
  vi.clearAllMocks();
  resetSqlMock();
  vi.mocked(createPat).mockResolvedValue({ id: 'p-1', prefix: 'pat_x', raw: 'pat_secret' } as never);
  vi.mocked(getOauthAppByClientId).mockResolvedValue({
    id: 'app-1', name: 'Claude', description: null, logoUrl: null, homepageUrl: null,
    redirectUris: ['https://claude.ai/cb'], clientId: 'client_abc', isVerified: false, isFirstParty: false, isConfidential: false,
  });
  vi.mocked(createAuthorisationCode).mockResolvedValue(`oac_${'C'.repeat(32)}`);
});

describe('scopesRoleMayNotHold — the shared policy', () => {
  it('a role that cannot write may hold no write:* scope; a writing role may hold all', () => {
    const scopes = ['read:reports', 'write:invoices', 'write:post', 'offline_access'];
    for (const role of ['viewer', 'storeman', 'technician', null, undefined]) {
      expect(scopesRoleMayNotHold(role, scopes)).toEqual(['write:invoices', 'write:post']);
    }
    for (const role of ['owner', 'admin', 'manager']) expect(scopesRoleMayNotHold(role, scopes)).toEqual([]);
  });
});

describe('POST /api/auth/personal-tokens — role gate on scopes', () => {
  it('refuses a viewer asking for write:post (403, nothing minted)', async () => {
    const res = makeRes();
    await (patHandler as H)(patReq('viewer', ['read:reports', 'write:post']), res);
    expect(res.statusCode).toBe(403);
    expect(res.body?.error?.message).toMatch(/write:post/);
    expect(createPat).not.toHaveBeenCalled();
  });

  it('lets a viewer mint a read-only token', async () => {
    const res = makeRes();
    await (patHandler as H)(patReq('viewer', ['read:reports', 'read:invoices']), res);
    expect(res.statusCode).toBe(201);
    expect(createPat).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['read:reports', 'read:invoices'] }));
  });

  it.each(['owner', 'admin', 'manager'])('lets a %s mint write scopes', async (role) => {
    const res = makeRes();
    await (patHandler as H)(patReq(role, ['write:journals', 'write:post']), res);
    expect(res.statusCode).toBe(201);
    expect(createPat).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/oauth/consent — role gate on granted scopes', () => {
  it('grants a viewer the read scopes only, even when write:post was ticked', async () => {
    const res = makeRes();
    await (consentHandler as H)(consentReq('viewer'), res);
    expect(res.statusCode).toBe(200);
    expect(granted()).toEqual(['read:reports']);
  });

  it('refuses a viewer whose request holds nothing but write scopes (no code minted)', async () => {
    const res = makeRes();
    await (consentHandler as H)(consentReq('viewer', { scopes: ['write:invoices'], optInConfirmed: [] }), res);
    expect(res.statusCode).toBe(403);
    expect(createAuthorisationCode).not.toHaveBeenCalled();
  });

  it('leaves a writing role\'s empty grant as it was (nothing withheld, no 403)', async () => {
    const res = makeRes();
    await (consentHandler as H)(consentReq('manager', { scopes: ['write:post'], optInConfirmed: [] }), res);
    expect(res.statusCode).toBe(200);
    expect(granted()).toEqual([]);
  });

  it('grants a manager every requested scope it ticked', async () => {
    const res = makeRes();
    await (consentHandler as H)(consentReq('manager'), res);
    expect(granted()).toEqual(['read:reports', 'write:invoices', 'write:post']);
  });

  it('judges the role in the TARGET company: an owner of the active company who is a viewer of the target gets reads only', async () => {
    mockSqlOnce([{ role: 'viewer' }]);
    const res = makeRes();
    await (consentHandler as H)(consentReq('owner', { companyId: OTHER }), res);
    expect(res.statusCode).toBe(200);
    expect(granted()).toEqual(['read:reports']);
  });

  it('and a viewer of the active company who is an admin of the target gets the writes', async () => {
    mockSqlOnce([{ role: 'admin' }]);
    const res = makeRes();
    await (consentHandler as H)(consentReq('viewer', { companyId: OTHER }), res);
    expect(granted()).toEqual(['read:reports', 'write:invoices', 'write:post']);
  });
});
