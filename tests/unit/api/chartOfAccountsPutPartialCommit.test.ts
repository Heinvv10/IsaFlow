/**
 * PUT /api/accounting/chart-of-accounts must not COMMIT a reclassify it is
 * about to report as a failure.
 *
 * The route does two writes: `reclassifyAccount` (subtype / parent / the level
 * cascade), then `updateAccount` (name, description, VAT, active). They share
 * withAuth's request-wide transaction, and `withAuth` decides COMMIT vs
 * ROLLBACK on `res.statusCode >= 500` — a 4xx COMMITS. So a single try/catch
 * mapping every failure to `apiResponse.badRequest` meant that when the
 * reclassify succeeded and the update then threw, the reclassify was committed
 * while the client was told the request failed: a silent partial write, and
 * the account's subtype/parent had changed with nothing in the response saying
 * so.
 *
 * The rule the tests below pin: a REFUSAL is a 400 (nothing was written, and
 * the service's reason is what the caller needs); anything else that happens
 * AFTER reclassify has written must propagate so the status reaches 500 and
 * withAuth rolls back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  getChartOfAccounts: vi.fn(),
  getAccountTree: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/accountReclassifyService', async () => {
  // ReclassifyError must be the real class — the route branches on it, and a
  // stubbed sentinel would let that branch pass by accident.
  const actual = await vi.importActual<
    typeof import('@/modules/accounting/services/gl/accountReclassifyService')
  >('@/modules/accounting/services/gl/accountReclassifyService');
  return { ReclassifyError: actual.ReclassifyError, reclassifyAccount: vi.fn() };
});

import { updateAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  reclassifyAccount,
  ReclassifyError,
} from '@/modules/accounting/services/gl/accountReclassifyService';
import handler from '../../../pages/api/accounting/chart-of-accounts';

const ACCOUNT = '22222222-2222-4222-8222-222222222222';

function mockReqRes(body: Record<string, unknown>) {
  const req = {
    method: 'PUT',
    query: {},
    body,
    companyId: 'co-1',
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reclassifyAccount).mockResolvedValue({ id: ACCOUNT } as never);
  vi.mocked(updateAccount).mockResolvedValue({ id: ACCOUNT } as never);
});

describe('PUT /api/accounting/chart-of-accounts — partial-commit safety', () => {
  it('PROPAGATES an updateAccount failure once reclassify has written', async () => {
    vi.mocked(updateAccount).mockRejectedValueOnce(new Error('boom'));
    const { req, res } = mockReqRes({ id: ACCOUNT, accountSubtype: 'bank', accountName: 'X' });

    // A returned 400 here is the bug: withAuth would COMMIT the reclassify.
    await expect(handler(req, res)).rejects.toThrow('boom');
    expect(res.statusCode).not.toBe(400);
  });

  it('still answers a plain rename failure with 400 — nothing was written to unwind', async () => {
    vi.mocked(updateAccount).mockRejectedValueOnce(new Error('Cannot deactivate a system account'));
    const { req, res } = mockReqRes({ id: ACCOUNT, isActive: false });

    await handler(req, res);
    expect(reclassifyAccount).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('system account');
  });

  it('answers a reclassify REFUSAL with 400 and never runs the update', async () => {
    vi.mocked(reclassifyAccount).mockRejectedValueOnce(
      new ReclassifyError('Parent 5000 has journal lines posted to it.'),
    );
    const { req, res } = mockReqRes({ id: ACCOUNT, parentAccountId: 'p-1', accountName: 'X' });

    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('journal lines posted');
    expect(updateAccount).not.toHaveBeenCalled();
  });

  it('PROPAGATES a non-refusal thrown by reclassify itself', async () => {
    // A deadlock or a driver error is not a 400 — mapping it to one would
    // commit whatever the service had already written before it failed.
    vi.mocked(reclassifyAccount).mockRejectedValueOnce(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );
    const { req, res } = mockReqRes({ id: ACCOUNT, parentAccountId: 'p-1' });

    await expect(handler(req, res)).rejects.toThrow('deadlock detected');
    expect(res.statusCode).not.toBe(400);
    expect(updateAccount).not.toHaveBeenCalled();
  });

  it('distinguishes an ABSENT classification key from an explicit null', async () => {
    const { req: r1, res: s1 } = mockReqRes({ id: ACCOUNT, accountName: 'Renamed' });
    await handler(r1, s1);
    expect(reclassifyAccount).not.toHaveBeenCalled();

    const { req: r2, res: s2 } = mockReqRes({ id: ACCOUNT, parentAccountId: null });
    await handler(r2, s2);
    expect(vi.mocked(reclassifyAccount).mock.calls[0]![2]).toEqual({ parentAccountId: null });
  });
});
