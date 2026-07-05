/**
 * W7 (P2.4): impersonate-exchange must move the ACTIVE COMPANY COOKIE, not
 * just return a label. withAuth scopes every query by the cookie and
 * hard-requires a company_users membership — so the exchange either sets the
 * cookie for a real membership or refuses with a pointer to
 * user-impersonation. Label-only responses showed the impersonated company's
 * name over the WRONG company's data (audit W7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(),
  withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
  fmtDate: (d: unknown) => String(d ?? ''),
}));

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: Function) => fn,
}));

vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (fn: Function) => fn,
}));

const setCookieMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/cookies', () => ({
  setActiveCompanyCookie: setCookieMock,
}));

const validateMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/admin/services/impersonationService', () => ({
  validateImpersonationToken: validateMock,
}));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    forbidden: vi.fn((_res: unknown, error: string) => ({ kind: 'forbidden', error })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
  },
}));

import handler from '../../../pages/api/auth/impersonate-exchange';

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const COMPANY_ID = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

function makeReq(): NextApiRequest {
  return {
    method: 'GET',
    query: { token: 'tok' },
    user: { id: ADMIN_ID },
  } as unknown as NextApiRequest;
}

function routeSql(hasMembership: boolean) {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = (strings as unknown as string[]).join('?');
    if (/SELECT role FROM users/i.test(text)) return Promise.resolve([{ role: 'super_admin' }]);
    // Model RLS: companies_member_read makes the companies row visible ONLY
    // to members — mirroring prod semantics so the membership-first ordering
    // in the handler is actually exercised (blind-review HIGH on PR #205).
    if (/FROM companies/i.test(text)) {
      return Promise.resolve(hasMembership ? [{ id: COMPANY_ID, name: 'Target Co' }] : []);
    }
    if (/FROM company_users/i.test(text)) return Promise.resolve(hasMembership ? [{ '?column?': 1 }] : []);
    return Promise.resolve([]);
  });
}

describe('impersonate-exchange cookie semantics (P2.4 / audit W7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateMock.mockResolvedValue({ company_id: COMPANY_ID, admin_user_id: ADMIN_ID });
  });

  it('sets the active_company cookie when the admin has a membership', async () => {
    routeSql(true);

    const result = (await (handler as Function)(makeReq(), {} as NextApiResponse)) as {
      kind: string;
    };

    expect(result.kind).toBe('success');
    expect(setCookieMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID);
  });

  it('refuses (never label-only) when the admin is NOT a member', async () => {
    routeSql(false);

    const result = (await (handler as Function)(makeReq(), {} as NextApiResponse)) as {
      kind: string;
      error?: string;
    };

    expect(result.kind).toBe('forbidden');
    expect(result.error).toMatch(/user-impersonation/i);
    expect(setCookieMock).not.toHaveBeenCalled();
  });
});
