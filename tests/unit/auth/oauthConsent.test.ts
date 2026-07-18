/**
 * Consent endpoint — company-membership gate (MCP Phase 1, Task 1.4 review
 * fix: body.companyId was trusted without a company_users re-check).
 *
 * Invariants:
 *  - an authorisation code can only be minted for a company the consenting
 *    user is actually a member of
 *  - default (no body.companyId) stays the withAuth-resolved active company
 *  - malformed companyId → 400 before any DB round-trip
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
}));

vi.mock('@/lib/auth/oauth', () => ({
  OAUTH_SCOPES: ['read:invoices', 'read:reports', 'offline_access'],
  getOauthAppByClientId: vi.fn(),
  createAuthorisationCode: vi.fn(),
}));

import { getOauthAppByClientId, createAuthorisationCode } from '@/lib/auth/oauth';
import handler from '../../../pages/api/oauth/consent';
import { resetSqlMock, mockSqlOnce, sqlMock, sqlCallValues } from './helpers';

const USER_ID = 'user-gotrue-1';
const HOME_COMPANY = '22222222-2222-2222-2222-222222222222';
const OTHER_COMPANY = '99999999-9999-9999-9999-999999999999';

interface FakeRes {
  statusCode: number;
  body?: { success: boolean; error?: { code: string }; data?: Record<string, unknown> };
}

function makeRes(): NextApiResponse & FakeRes {
  const res = {
    statusCode: 200,
    body: undefined as FakeRes['body'],
    setHeader() { return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: FakeRes['body']) { res.body = b; return res; },
  };
  return res as unknown as NextApiResponse & FakeRes;
}

function makeReq(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    url: '/api/oauth/consent',
    user: { id: USER_ID, claims: {} },
    companyId: HOME_COMPANY,
    body: {
      clientId: 'client_abc',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: 'challenge123',
      codeChallengeMethod: 'S256',
      scopes: ['read:reports'],
      ...extra,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSqlMock();
  vi.mocked(getOauthAppByClientId).mockResolvedValue({
    id: 'app-1', name: 'Claude', description: null, logoUrl: null, homepageUrl: null,
    redirectUris: ['https://claude.ai/cb'], clientId: 'client_abc',
    isVerified: false, isFirstParty: false, isConfidential: false,
  });
  vi.mocked(createAuthorisationCode).mockResolvedValue(`oac_${'C'.repeat(32)}`);
});

describe('POST /api/oauth/consent — company membership gate', () => {
  it('rejects a companyId the user is not a member of (403, no code minted)', async () => {
    mockSqlOnce([]); // membership probe: no row
    const res = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(
      makeReq({ companyId: OTHER_COMPANY }), res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body?.error?.code).toBe('FORBIDDEN');
    expect(createAuthorisationCode).not.toHaveBeenCalled();
    // probe was scoped to (user, target company)
    expect(sqlCallValues(0)).toEqual(expect.arrayContaining([USER_ID, OTHER_COMPANY]));
  });

  it('allows a companyId the user IS a member of (multi-company user)', async () => {
    mockSqlOnce([{ ok: 1 }]); // membership probe: row exists
    const res = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(
      makeReq({ companyId: OTHER_COMPANY }), res,
    );
    expect(res.statusCode).toBe(200);
    expect(createAuthorisationCode).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: OTHER_COMPANY, userId: USER_ID }),
    );
  });

  it('defaults to the withAuth-resolved company without a membership round-trip', async () => {
    const res = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(createAuthorisationCode).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: HOME_COMPANY }),
    );
    expect(sqlMock).not.toHaveBeenCalled(); // no probe needed for the active company
  });

  it('rejects a malformed companyId before any DB round-trip', async () => {
    const res = makeRes();
    await (handler as (req: unknown, res: unknown) => Promise<void>)(
      makeReq({ companyId: "1'; DROP TABLE oauth_apps; --" }), res,
    );
    expect(res.statusCode).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(createAuthorisationCode).not.toHaveBeenCalled();
  });
});
