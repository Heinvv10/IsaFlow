/**
 * verify-email sends the new owner's welcome email, and only where this
 * request's transaction has just created their company: never when
 * provisioning fails, never on a replayed or recovered link, never for a user
 * who already owned a tenant, never before the GoTrue confirmation lands. A
 * failing send never changes the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiRequest, NextApiResponse } from 'next';

const {
  consumeMock, findConsumedMock, provisionMock, bureauMock,
  updateUserMock, getUserMock, sendEmailMock, sqlMock, clientQueryMock, welcomeMock,
} = vi.hoisted(() => ({
  consumeMock: vi.fn(), findConsumedMock: vi.fn(), provisionMock: vi.fn(), bureauMock: vi.fn(),
  updateUserMock: vi.fn(), getUserMock: vi.fn(), sendEmailMock: vi.fn(), sqlMock: vi.fn(),
  clientQueryMock: vi.fn(), welcomeMock: vi.fn(),
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
vi.mock('@/lib/auth/gotrue', () => ({ adminUpdateUser: updateUserMock }));
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: getUserMock }));
vi.mock('@/lib/auth/emailVerificationService', () => ({
  consumeEmailVerificationToken: consumeMock,
  findConsumedVerification: findConsumedMock,
}));
vi.mock('@/modules/onboarding/services/tenantProvisioningService', () => ({ provisionTenant: provisionMock }));
vi.mock('@/modules/bureau/services/signupBureauService', () => ({ setUpSignupBureau: bureauMock }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/modules/onboarding/services/welcomeEmail', () => ({ sendWelcomeEmail: welcomeMock }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/rateLimit', () => ({ withRateLimit: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import handler from '@/../pages/api/auth/verify-email';

const TOKEN = 'b'.repeat(64);
const pending = {
  email: 'owner@example.co.za', firstName: 'Thandi', lastName: 'Owner', companyName: 'Example Traders',
  phone: null, annualTurnoverCents: 75_000_000, signupType: 'direct' as 'direct' | 'accountant',
};

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as NextApiResponse & { statusCode: number };
}
const req = () => ({ method: 'POST', body: { token: TOKEN }, headers: {}, socket: {} }) as unknown as NextApiRequest;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIGRATION_ADMIN_DATABASE_URL = 'postgres://test/test';
  clientQueryMock.mockResolvedValue({ rows: [] });
  consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending });
  provisionMock.mockResolvedValue({ companyId: 'company-1', paygEligible: true });
  bureauMock.mockResolvedValue({ status: 'created', bureauId: 'bureau-1' });
  updateUserMock.mockResolvedValue(undefined);
  getUserMock.mockResolvedValue({ id: 'user-1', email: 'owner@example.co.za' });
  sendEmailMock.mockResolvedValue({ success: true });
  findConsumedMock.mockResolvedValue(null);
  sqlMock.mockResolvedValue([]);
  welcomeMock.mockReturnValue(undefined);
});

describe('verify-email: welcome email', () => {
  it('sends it once, to the new owner, after a successful provisioning', async () => {
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(200);
    expect(welcomeMock).toHaveBeenCalledTimes(1);
    expect(welcomeMock).toHaveBeenCalledWith({
      companyId: 'company-1', email: 'owner@example.co.za', firstName: 'Thandi',
      companyName: 'Example Traders', signupType: 'direct',
    });
  });

  it('passes the stored accountant signup type through', async () => {
    consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending: { ...pending, signupType: 'accountant' } });
    await handler(req(), mockRes());
    expect(welcomeMock).toHaveBeenCalledWith(expect.objectContaining({ signupType: 'accountant' }));
  });

  it('does not send when provisioning fails', async () => {
    provisionMock.mockRejectedValue(new Error('db down'));
    await expect(handler(req(), mockRes())).rejects.toThrow('db down');
    expect(welcomeMock).not.toHaveBeenCalled();
  });

  it('does not send when the GoTrue confirmation fails after provisioning', async () => {
    updateUserMock.mockRejectedValue(new Error('gotrue down'));
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(503);
    expect(welcomeMock).not.toHaveBeenCalled();
  });

  it('does not send again when an already-used link is opened (recovery path)', async () => {
    consumeMock.mockResolvedValue(null);
    findConsumedMock.mockResolvedValue({ gotrueUserId: 'user-1', pending });
    sqlMock.mockResolvedValue([{ company_id: 'company-1' }]);
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(200);
    expect(welcomeMock).not.toHaveBeenCalled();
  });

  it('does not send for a user who already owns a tenant', async () => {
    clientQueryMock.mockImplementation(async (text: string) =>
      /SELECT company_id FROM company_users/i.test(String(text))
        ? { rows: [{ company_id: 'existing-company' }] }
        : { rows: [] });
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(200);
    expect(welcomeMock).not.toHaveBeenCalled();
  });

  it('a welcome send that fails does not change the 200 (real welcome module)', async () => {
    const actual = await vi.importActual<typeof import('@/modules/onboarding/services/welcomeEmail')>(
      '@/modules/onboarding/services/welcomeEmail',
    );
    welcomeMock.mockImplementation(actual.sendWelcomeEmail);
    sqlMock.mockResolvedValue([{ is_demo: false, already_sent: false }]);
    // The ops mail succeeds, the welcome send rejects.
    sendEmailMock.mockImplementation(async (o: { subject: string }) => {
      if (o.subject.includes('IsaFlow signup')) return { success: true };
      throw new Error('smtp down');
    });
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(sendEmailMock).toHaveBeenCalledTimes(2));
  });
});
