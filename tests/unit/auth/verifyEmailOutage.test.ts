/**
 * D9 round 4: POST /api/auth/verify-email when GoTrue cannot confirm the address.
 *
 * The verification token is consumed (and the tenant committed) before the
 * GoTrue confirmation runs, so an outage there must never strand the signup:
 * every one of the three confirmation calls answers 503 CONFIRMATION_INCOMPLETE
 * (never a 500), and opening the SAME link again completes the job through the
 * consumed-token recovery path. adminUpdateUser is mocked to throw the real
 * AuthUpstreamUnavailableError; its own classification is pinned in
 * authUpstreamReauth.test.ts and authUpstreamAdminUpdate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiRequest, NextApiResponse } from 'next';
import { AuthUpstreamUnavailableError } from '@/lib/auth/authUpstream';

const {
  consumeMock, findConsumedMock, provisionMock, updateUserMock, sqlMock, clientQueryMock,
} = vi.hoisted(() => ({
  consumeMock: vi.fn(),
  findConsumedMock: vi.fn(),
  provisionMock: vi.fn(),
  updateUserMock: vi.fn(),
  sqlMock: vi.fn(),
  clientQueryMock: vi.fn(),
}));

vi.mock('pg', () => ({
  default: {
    ...pgTypesMock(),
    Pool: class {
      connect = async () => ({ query: clientQueryMock, release: vi.fn() });
      end = vi.fn();
      on = vi.fn();
    },
  },
}));
// adminGetUser (S-07c C4) answers with the token's own address; verifyEmail.test.ts covers a mismatch.
vi.mock('@/lib/auth/gotrue', () => ({ adminUpdateUser: updateUserMock }));
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: vi.fn(async (id: string) => ({ id, email: 'lead@example.co.za' })) }));
vi.mock('@/lib/auth/emailVerificationService', () => ({
  consumeEmailVerificationToken: consumeMock,
  findConsumedVerification: findConsumedMock,
}));
vi.mock('@/modules/onboarding/services/tenantProvisioningService', () => ({ provisionTenant: provisionMock }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/rateLimit', () => ({ withRateLimit: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import handler from '@/../pages/api/auth/verify-email';

const TOKEN = 'b'.repeat(64);
const pending = {
  email: 'lead@example.co.za', firstName: 'Lead', lastName: 'Person', companyName: 'Lead Co',
  phone: null, annualTurnoverCents: 75_000_000, signupType: 'direct' as const,
};
const outage = () => new AuthUpstreamUnavailableError('gotrue adminUpdateUser unavailable: 503');

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: { error?: { code: string }; data?: { companyId?: string } } };
}
const req = () => ({ method: 'POST', body: { token: TOKEN }, headers: {}, socket: {} }) as unknown as NextApiRequest;

/** The link opened a second time: the token is consumed and the tenant exists, so recovery runs. */
function asReopenedLink(): void {
  consumeMock.mockResolvedValue(null);
  findConsumedMock.mockResolvedValue({ gotrueUserId: 'user-1', pending });
  sqlMock.mockResolvedValue([{ company_id: 'company-1' }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIGRATION_ADMIN_DATABASE_URL = 'postgres://test/test';
  clientQueryMock.mockResolvedValue({ rows: [] });
  consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending });
  provisionMock.mockResolvedValue({ companyId: 'company-1', paygEligible: true });
  findConsumedMock.mockResolvedValue(null);
  sqlMock.mockResolvedValue([]);
  updateUserMock.mockResolvedValue(undefined);
});

async function expectIncompleteThenRecovered(): Promise<void> {
  const first = mockRes();
  await handler(req(), first);
  expect(first.statusCode).toBe(503);
  expect(first.body.error?.code).toBe('CONFIRMATION_INCOMPLETE');
  asReopenedLink();
  updateUserMock.mockResolvedValue(undefined);
  const second = mockRes();
  await handler(req(), second);
  expect(second.statusCode).toBe(200);
  expect(second.body.data?.companyId).toBe('company-1');
  expect(provisionMock.mock.calls.length).toBeLessThanOrEqual(1); // never provisioned twice
}

describe('verify-email during a GoTrue outage', () => {
  it('confirmation after a new tenant commits: 503, and the same link completes it', async () => {
    updateUserMock.mockRejectedValueOnce(outage());
    await expectIncompleteThenRecovered();
  });

  it('a user who already owns a tenant: 503 (not 500), and the same link completes it', async () => {
    clientQueryMock.mockImplementation(async (text: string) =>
      (/FROM company_users/.test(String(text)) ? { rows: [{ company_id: 'company-1' }] } : { rows: [] }));
    updateUserMock.mockRejectedValueOnce(outage());
    await expectIncompleteThenRecovered();
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it('the recovery itself meets the outage: 503 (not 500), and opening the link once more completes it', async () => {
    asReopenedLink();
    updateUserMock.mockRejectedValueOnce(outage());
    await expectIncompleteThenRecovered();
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it('a recovery failure that is not an outage still throws (500), as before', async () => {
    asReopenedLink();
    updateUserMock.mockRejectedValueOnce(new Error('gotrue adminUpdateUser failed: 404 user not found'));
    await expect(handler(req(), mockRes())).rejects.toThrow('404');
  });
});
