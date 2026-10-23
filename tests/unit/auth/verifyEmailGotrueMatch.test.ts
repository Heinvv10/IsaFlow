/**
 * POST /api/auth/verify-email, S-07c C4: the GoTrue address check. Same
 * harness as verifyEmail.test.ts.
 *
 * POST /api/auth/verify-email — where a signup becomes a tenant.
 *
 * This endpoint is unauthenticated and the only thing standing between a link
 * and a provisioned company, so the properties pinned here are:
 *   - consumption and provisioning share ONE transaction, so a provisioning
 *     failure rolls back the consumption and the link still works
 *   - the GoTrue confirmation runs only after that transaction commits
 *   - a user can never end up owning two tenants
 *   - a consumed link whose tenant exists completes the job instead of 410ing
 *   - the ops notification never fires for an unverified address
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiRequest, NextApiResponse } from 'next';

const {
  consumeMock, findConsumedMock, provisionMock,
  updateUserMock, getUserMock, sendEmailMock, sqlMock, clientQueryMock, releaseMock, endMock,
} = vi.hoisted(() => ({
  consumeMock: vi.fn(),
  findConsumedMock: vi.fn(),
  provisionMock: vi.fn(),
  updateUserMock: vi.fn(),
  getUserMock: vi.fn(),
  sendEmailMock: vi.fn(),
  sqlMock: vi.fn(),
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  endMock: vi.fn(),
}));

vi.mock('pg', () => ({
  default: {
    ...pgTypesMock(),
    Pool: class {
      connect = async () => ({ query: clientQueryMock, release: releaseMock });
      end = endMock;
      on = vi.fn(); // the route listens for pool errors (R-176)
    },
  },
}));
vi.mock('@/lib/auth/gotrue', () => ({ adminUpdateUser: updateUserMock }));
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: getUserMock }));
vi.mock('@/lib/auth/emailVerificationService', () => ({
  consumeEmailVerificationToken: consumeMock,
  findConsumedVerification: findConsumedMock,
}));
vi.mock('@/modules/onboarding/services/tenantProvisioningService', () => ({
  provisionTenant: provisionMock,
}));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/rateLimit', () => ({ withRateLimit: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import handler from '@/../pages/api/auth/verify-email';
import { AuthUpstreamUnavailableError } from '@/lib/auth/authUpstream';

const TOKEN = 'a'.repeat(64);

const pending = {
  email: 'lead@example.co.za',
  firstName: 'Lead',
  lastName: 'Person',
  companyName: 'Lead Co',
  phone: null,
  annualTurnoverCents: 75_000_000,
  signupType: 'direct' as const,
};

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: { success: boolean; data?: { companyId?: string } };
  };
}

const req = (token: unknown = TOKEN) =>
  ({ method: 'POST', body: { token }, headers: {}, socket: {} }) as unknown as NextApiRequest;

/** Statements issued on the pooled client, in order. */
const clientStatements = () =>
  clientQueryMock.mock.calls.map((c) => String(c[0]).trim().split('\n')[0]!.trim());

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIGRATION_ADMIN_DATABASE_URL = 'postgres://test/test';
  clientQueryMock.mockResolvedValue({ rows: [] });
  consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending });
  provisionMock.mockResolvedValue({ companyId: 'company-1', paygEligible: true });
  updateUserMock.mockResolvedValue(undefined);
  getUserMock.mockResolvedValue({ id: 'user-1', email: 'Lead@Example.co.za' });
  sendEmailMock.mockResolvedValue(undefined);
  findConsumedMock.mockResolvedValue(null);
  sqlMock.mockResolvedValue([]);
});

// S-07c C4: the token's payload email becomes users.email and the tenant's
// address, so a tenant is provisioned only for the address GoTrue holds for
// the token's user. A refusal or an outage consumes nothing.
describe('verify-email — the payload email must be the GoTrue user\'s (S-07c C4)', () => {
  it('reads the token user from GoTrue and provisions when the addresses match (case-insensitively)', async () => {
    const res = mockRes();
    await handler(req(), res);
    expect(getUserMock).toHaveBeenCalledWith('user-1');
    expect(res.statusCode).toBe(200);
    expect(provisionMock).toHaveBeenCalled();
  });

  it.each([
    ['another address', { id: 'user-1', email: 'someone-else@example.co.za' }],
    ['no GoTrue user', null],
  ])('%s: 409 EMAIL_MISMATCH, nothing provisioned or confirmed, the consumption rolled back', async (_, user) => {
    getUserMock.mockResolvedValueOnce(user);
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'EMAIL_MISMATCH' } });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(clientStatements()).toContain('ROLLBACK');
    expect(clientStatements()).not.toContain('COMMIT');
  });

  it('a GoTrue outage: 503 CONFIRMATION_INCOMPLETE, nothing provisioned, the consumption rolled back', async () => {
    getUserMock.mockRejectedValueOnce(new AuthUpstreamUnavailableError('gotrue adminGetUser unavailable: 503'));
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: 'CONFIRMATION_INCOMPLETE' } });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(clientStatements()).toContain('ROLLBACK');
    expect(clientStatements()).not.toContain('COMMIT');
  });

  it('another GoTrue refusal (400) is not an outage: it throws, nothing provisioned, the consumption rolled back', async () => {
    getUserMock.mockRejectedValueOnce(new Error('gotrue adminGetUser failed: 400'));
    await expect(handler(req(), mockRes())).rejects.toThrow('gotrue adminGetUser failed: 400');
    expect(provisionMock).not.toHaveBeenCalled();
    expect(clientStatements()).toContain('ROLLBACK');
    expect(clientStatements()).not.toContain('COMMIT');
  });
});
