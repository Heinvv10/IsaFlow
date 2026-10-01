/**
 * POST /api/payroll/runs/[id]/reopen (W3-01 round 4).
 *
 * The route answered EVERY thrown error with a 400, and withAuth COMMITs a
 * 4xx: an unexpected failure after a write would have been committed. Only
 * reopenPayrollRun's own refusals — raised before its one write — are a 400
 * now; anything else propagates, so it is a 500 and the request rolls back.
 * A malformed id is refused before the service instead of reaching `::uuid`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withCsrf: (h: unknown) => h,
  withWriteAccess: (await import('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/payroll/payrollRunLock')>()),
  reopenPayrollRun: vi.fn(),
}));

import { PayrollRunReopenRefusedError, reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunLock';
import handler from '../../../pages/api/payroll/runs/[id]/reopen';

const RUN = '22222222-2222-4222-8222-222222222222';

function mockReqRes(query: Record<string, unknown> = { id: RUN }) {
  const req = {
    method: 'POST', query, body: { reason: 'a good reason' },
    companyId: 'co-1', companyRole: 'admin', user: { id: 'u-1' },
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

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/payroll/runs/[id]/reopen', () => {
  it('answers the service\'s own refusal with 400', async () => {
    vi.mocked(reopenPayrollRun).mockRejectedValueOnce(new PayrollRunReopenRefusedError('Paid runs cannot be reopened'));
    const { req, res } = mockReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('PROPAGATES anything unexpected so the request rolls back', async () => {
    vi.mocked(reopenPayrollRun).mockRejectedValueOnce(new Error('connection lost'));
    const { req, res } = mockReqRes();
    await expect(handler(req, res)).rejects.toThrow('connection lost');
    expect(res.statusCode).not.toBe(400);
  });

  it.each([['not-a-uuid'], ["x' OR 1=1--"], [[RUN, 'x']], [undefined]])(
    'answers a malformed id %j with 400 before the service is called', async (id) => {
      const { req, res } = mockReqRes({ id });
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(reopenPayrollRun).not.toHaveBeenCalled();
    });

  it('reopens and returns the result', async () => {
    vi.mocked(reopenPayrollRun).mockResolvedValueOnce({ runId: RUN, previousStatus: 'approved', newStatus: 'calculated' });
    const { req, res } = mockReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(reopenPayrollRun).toHaveBeenCalledWith({ runId: RUN, companyId: 'co-1', userId: 'u-1', reason: 'a good reason' });
  });
});
