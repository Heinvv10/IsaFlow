/**
 * POST /api/auth/verify-email: the bureau an Accountant sign-up gets.
 *
 * The bureau step is keyed on the sign-up type STORED in the token row at
 * registration, never on the request body, and runs only where this request
 * has just provisioned the user's new company, on the same transaction, before
 * COMMIT. A setup that reports 'failed' degrades: the sign-up still commits and
 * ops is told to convert on the admin route. One that throws rolls everything
 * back. The harness is verifyEmail.test.ts's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pgTypesMock } from '../helpers/pgTypesMock';
import type { NextApiRequest, NextApiResponse } from 'next';

const {
  consumeMock, findConsumedMock, provisionMock, bureauMock,
  updateUserMock, getUserMock, sendEmailMock, sqlMock, clientQueryMock, releaseMock, endMock,
} = vi.hoisted(() => ({
  bureauMock: vi.fn(),
  consumeMock: vi.fn(),
  findConsumedMock: vi.fn(),
  provisionMock: vi.fn(),
  updateUserMock: vi.fn(), getUserMock: vi.fn(),
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
vi.mock('@/lib/auth/gotrueAdminUser', () => ({ adminGetUser: getUserMock })); // its refusals: verifyEmailGotrueMatch.test.ts
vi.mock('@/lib/auth/emailVerificationService', () => ({
  consumeEmailVerificationToken: consumeMock,
  findConsumedVerification: findConsumedMock,
}));
vi.mock('@/modules/onboarding/services/tenantProvisioningService', () => ({
  provisionTenant: provisionMock,
}));
vi.mock('@/modules/bureau/services/signupBureauService', () => ({ setUpSignupBureau: bureauMock }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/rateLimit', () => ({ withRateLimit: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import handler from '@/../pages/api/auth/verify-email';

const TOKEN = 'a'.repeat(64);

const pending = {
  email: 'lead@example.co.za',
  firstName: 'Lead',
  lastName: 'Person',
  companyName: 'Lead Co',
  phone: null,
  annualTurnoverCents: 75_000_000,
  signupType: 'direct' as 'direct' | 'accountant',
};
const accountant = { ...pending, companyName: 'Smith Practice', signupType: 'accountant' as const };

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

const req = (token: unknown = TOKEN, extra: Record<string, unknown> = {}) =>
  ({ method: 'POST', body: { token, ...extra }, headers: {}, socket: {} }) as unknown as NextApiRequest;

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
  bureauMock.mockResolvedValue({ status: 'created', bureauId: 'bureau-1' });
});


const ops = () => (sendEmailMock.mock.calls[0]![0] as { html: string; _log: { companyId: unknown } });

describe('verify-email bureau: who gets one', () => {
  it('accountant token: set up once, on the provisioning client, with server-derived ids, before COMMIT', async () => {
    consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending: accountant });
    const order: string[] = [];
    clientQueryMock.mockImplementation(async (text: string) => {
      if (String(text).trim() === 'COMMIT') order.push('COMMIT');
      return { rows: [] };
    });
    bureauMock.mockImplementation(async () => { order.push('BUREAU'); return { status: 'created', bureauId: 'bureau-1' }; });
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(200);
    expect(bureauMock).toHaveBeenCalledTimes(1);
    expect(bureauMock.mock.calls[0]![0]).toBe(provisionMock.mock.calls[0]![0]);
    expect(bureauMock.mock.calls[0]![1]).toEqual({
      ownerUserId: 'user-1', ownerEmail: 'lead@example.co.za', companyId: 'company-1', practiceName: 'Smith Practice',
    });
    expect(order).toEqual(['BUREAU', 'COMMIT']);
    // The bureau id is not returned to an unauthenticated caller.
    expect(res.body).toEqual({ success: true, data: { companyId: 'company-1' } });
  });

  it('direct token: no bureau', async () => {
    await handler(req(), mockRes());
    expect(bureauMock).not.toHaveBeenCalled();
  });

  it('a token payload without a sign-up type: no bureau', async () => {
    const { signupType: _drop, ...legacy } = pending;
    consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending: legacy });
    await handler(req(), mockRes());
    expect(bureauMock).not.toHaveBeenCalled();
  });

  it('a client flag cannot ask for one: direct token, forged body', async () => {
    await handler(req(TOKEN, { signupType: 'accountant', accountType: 'bureau_owner', companyId: 'other-co' }), mockRes());
    expect(bureauMock).not.toHaveBeenCalled();
  });

  it('a client flag cannot refuse or redirect one: accountant token, forged body', async () => {
    consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending: accountant });
    await handler(req(TOKEN, { signupType: 'direct', companyId: 'other-co', userId: 'user-2' }), mockRes());
    expect(bureauMock).toHaveBeenCalledTimes(1);
    expect(bureauMock.mock.calls[0]![1]).toMatchObject({ ownerUserId: 'user-1', companyId: 'company-1' });
  });

  it('a replayed link (token already consumed): no bureau', async () => {
    consumeMock.mockResolvedValue(null);
    findConsumedMock.mockResolvedValue({ gotrueUserId: 'user-1', pending: accountant });
    sqlMock.mockResolvedValue([{ company_id: 'company-1' }]);
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(200);
    expect(bureauMock).not.toHaveBeenCalled();
  });

  it('a user who already owns a tenant: no bureau', async () => {
    consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending: accountant });
    clientQueryMock.mockImplementation(async (text: string) =>
      (/SELECT company_id FROM company_users/i.test(String(text)) ? { rows: [{ company_id: 'existing' }] } : { rows: [] }));
    await handler(req(), mockRes());
    expect(provisionMock).not.toHaveBeenCalled();
    expect(bureauMock).not.toHaveBeenCalled();
  });
});

describe('verify-email bureau: outcomes', () => {
  beforeEach(() => consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending: accountant }));

  it('created: ops mail says so, still logged against no company', async () => {
    await handler(req(), mockRes());
    expect(ops().html).toContain('created automatically (bureau-1)');
    expect(ops()._log.companyId).toBeNull();
  });

  it('failed: the sign-up still commits and confirms, ops is told to convert', async () => {
    bureauMock.mockResolvedValue({ status: 'failed' });
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(200);
    expect(clientStatements()).toContain('COMMIT');
    expect(updateUserMock).toHaveBeenCalledWith('user-1', { email_confirm: true });
    expect(ops().html).toContain('automatic setup FAILED, convert on /admin/users/user-1');
  });

  it('existing: ops is told a second company was provisioned, not that a bureau was created', async () => {
    bureauMock.mockResolvedValue({ status: 'existing', bureauId: 'bureau-1' });
    await handler(req(), mockRes());
    expect(ops().html).toContain('already existed (bureau-1); a second company was provisioned for this user, check /admin/users/user-1');
    expect(ops().html).not.toContain('created automatically');
  });

  it('throws: everything rolls back, nothing confirmed, no mail', async () => {
    bureauMock.mockRejectedValue(new TypeError('boom'));
    await expect(handler(req(), mockRes())).rejects.toThrow('boom');
    expect(clientStatements()).toContain('ROLLBACK');
    expect(clientStatements()).not.toContain('COMMIT');
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('a direct sign-up mail has no bureau line', async () => {
    consumeMock.mockResolvedValue({ gotrueUserId: 'user-1', pending });
    await handler(req(), mockRes());
    expect(ops().html).not.toContain('Bureau:');
  });
});
