/**
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
vi.mock('@/lib/auth/gotrue', () => ({ adminUpdateUser: updateUserMock, adminGetUser: getUserMock }));
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

describe('verify-email — token shape', () => {
  it('rejects a malformed token without touching the database', async () => {
    const res = mockRes();
    await handler(req('not-a-token'), res);
    expect(res.statusCode).toBe(400);
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('rejects a missing token', async () => {
    const res = mockRes();
    const bodiless = { method: 'POST', body: {}, headers: {}, socket: {} } as unknown as NextApiRequest;
    await handler(bodiless, res);
    expect(res.statusCode).toBe(400);
    expect(consumeMock).not.toHaveBeenCalled();
  });
});

describe('verify-email — happy path', () => {
  it('provisions the tenant and confirms the address', async () => {
    const res = mockRes();
    await handler(req(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data?.companyId).toBe('company-1');
    expect(provisionMock).toHaveBeenCalled();
    expect(updateUserMock).toHaveBeenCalledWith('user-1', { email_confirm: true });
  });

  it('consumes and provisions inside ONE transaction', async () => {
    await handler(req(), mockRes());

    // consume runs on the same client the transaction is open on
    expect(consumeMock.mock.calls[0]![0]).toBe(provisionMock.mock.calls[0]![0]);
    const statements = clientStatements();
    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('COMMIT');
  });

  it('confirms the address only AFTER the transaction commits', async () => {
    const order: string[] = [];
    clientQueryMock.mockImplementation(async (text: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(String(text).trim())) order.push(String(text).trim());
      return { rows: [] };
    });
    updateUserMock.mockImplementation(async () => { order.push('CONFIRM'); });

    await handler(req(), mockRes());

    expect(order).toEqual(['BEGIN', 'COMMIT', 'CONFIRM']);
  });

  it('notifies ops only once the tenant exists', async () => {
    await handler(req(), mockRes());
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sent = sendEmailMock.mock.calls[0]![0] as { subject: string; _log: { companyId: null } };
    expect(sent.subject).toContain('ISAFlow signup');
    // Internal mail: logging it against the tenant surfaces it in their own
    // Customer Communication report.
    expect(sent._log.companyId).toBeNull();
  });
});

describe('verify-email — failure and recovery', () => {
  it('rolls the consumption back when provisioning fails, so the link survives', async () => {
    provisionMock.mockRejectedValue(new Error('db down'));

    await expect(handler(req(), mockRes())).rejects.toThrow('db down');

    const statements = clientStatements();
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    // Never confirm an address for a tenant that does not exist.
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('releases the client and pool even when provisioning throws', async () => {
    provisionMock.mockRejectedValue(new Error('db down'));
    await expect(handler(req(), mockRes())).rejects.toThrow();
    expect(releaseMock).toHaveBeenCalled();
    expect(endMock).toHaveBeenCalled();
  });

  it('tells the user to retry when the post-commit confirmation fails', async () => {
    updateUserMock.mockRejectedValue(new Error('gotrue down'));
    const res = mockRes();

    await handler(req(), res);

    expect(res.statusCode).toBe(503);
    expect(clientStatements()).toContain('COMMIT');
  });

  it('completes a half-finished signup when the link is opened again', async () => {
    consumeMock.mockResolvedValue(null); // already consumed
    findConsumedMock.mockResolvedValue({ gotrueUserId: 'user-1', pending });
    sqlMock.mockResolvedValue([{ company_id: 'company-1' }]);
    const res = mockRes();

    await handler(req(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data?.companyId).toBe('company-1');
    expect(updateUserMock).toHaveBeenCalledWith('user-1', { email_confirm: true });
    // Recovery must never provision again.
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it('410s a consumed token with no tenant behind it', async () => {
    consumeMock.mockResolvedValue(null);
    findConsumedMock.mockResolvedValue({ gotrueUserId: 'user-1', pending });
    sqlMock.mockResolvedValue([]); // no company
    const res = mockRes();

    await handler(req(), res);

    expect(res.statusCode).toBe(410);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it('410s an unknown token', async () => {
    consumeMock.mockResolvedValue(null);
    findConsumedMock.mockResolvedValue(null);
    const res = mockRes();

    await handler(req(), res);

    expect(res.statusCode).toBe(410);
  });
});

describe('verify-email — a ROLLBACK that fails destroys the connection (R-176)', () => {
  const refuseRollback = () => clientQueryMock.mockImplementation(async (text: string) => {
    if (text === 'ROLLBACK') throw new Error('R-176 forced: ROLLBACK never reached the server');
    return { rows: [] };
  });

  it('provisioning throws, its ROLLBACK fails: released with true, the pool still ended, the error rethrown', async () => {
    provisionMock.mockRejectedValue(new Error('db down'));
    refuseRollback();
    await expect(handler(req(), mockRes())).rejects.toThrow('db down');
    expect(releaseMock.mock.calls).toEqual([[true]]);
    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it('an unknown token whose ROLLBACK fails: still 410, released with true, the pool still ended', async () => {
    consumeMock.mockResolvedValue(null);
    refuseRollback();
    const res = mockRes();
    await handler(req(), res);
    expect(res.statusCode).toBe(410);
    expect(releaseMock.mock.calls).toEqual([[true]]);
    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it('an unknown token whose ROLLBACK fails, then a throw: the stuck client is not rolled back a second time', async () => {
    consumeMock.mockResolvedValue(null);
    findConsumedMock.mockRejectedValue(new Error('db down')); // throws after the early ROLLBACK, into the catch
    refuseRollback();
    await expect(handler(req(), mockRes())).rejects.toThrow('db down');
    expect(clientStatements().filter((t) => t === 'ROLLBACK')).toHaveLength(1);
    expect(releaseMock.mock.calls).toEqual([[true]]);
    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['provisioning throws, ROLLBACK succeeds', () => provisionMock.mockRejectedValue(new Error('db down'))],
    ['an unknown token, ROLLBACK succeeds', () => consumeMock.mockResolvedValue(null)],
    ['success', () => undefined],
  ])('%s: released with false (the connection is reused)', async (_what, arrange) => {
    arrange();
    await handler(req(), mockRes()).catch(() => undefined);
    expect(releaseMock.mock.calls).toEqual([[false]]);
    expect(endMock).toHaveBeenCalledTimes(1);
  });
});

describe('verify-email — one tenant per user', () => {
  it('never provisions a second tenant for a user who already owns one', async () => {
    // Two live tokens can exist for one GoTrue user when concurrent
    // registrations of the same new address collapse onto the same account.
    clientQueryMock.mockImplementation(async (text: string) => {
      if (/SELECT company_id FROM company_users/i.test(String(text))) {
        return { rows: [{ company_id: 'existing-company' }] };
      }
      return { rows: [] };
    });
    const res = mockRes();

    await handler(req(), res);

    expect(provisionMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.data?.companyId).toBe('existing-company');
    expect(clientStatements()).toContain('COMMIT');
  });
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
});
