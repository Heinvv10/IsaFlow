/**
 * POST /api/payroll/runs/[id]/mark-paid (wave 7 MP, W27). The route's own gates, before the service runs: method,
 * id, the approving roles, the body's shape; then each service refusal answered with its status and details.reason,
 * Login-as answered 403, and anything else rethrown (a 500, which rolls the request back).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApprove: vi.fn(async () => true) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  withCsrf: (h: unknown) => h,
  withWriteAccess: (await import('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/payroll/payrollRunMarkPaid', () => ({ markPayrollRunPaid: vi.fn() }));

import { markPayrollRunPaid } from '@/modules/accounting/services/payroll/payrollRunMarkPaid';
import { PayrollRunMarkPaidRefusal } from '@/modules/accounting/services/payroll/payrollRunMarkPaidJudge';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import handler from '../../../pages/api/payroll/runs/[id]/mark-paid';

const RUN = '22222222-2222-4222-8222-222222222222';

function mockReqRes(over: { query?: Record<string, unknown>; body?: unknown; role?: string; method?: string } = {}) {
  const req = {
    method: over.method ?? 'POST', query: over.query ?? { id: RUN }, body: over.body ?? {}, headers: {},
    companyId: 'co-1', companyRole: over.role ?? 'admin', user: { id: 'u-1', email: 'u@example.invalid', claims: { session_id: 's-1' } },
    socket: { remoteAddress: '127.0.0.1' },
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
const reasonOf = (sent: unknown) => (sent as { error?: { details?: { reason?: string } } }).error?.details?.reason;

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/payroll/runs/[id]/mark-paid', () => {
  it('typed path: passes the reference and date and the actor to the service; 200 with its result', async () => {
    vi.mocked(markPayrollRunPaid).mockResolvedValueOnce({ runId: RUN, status: 'paid', evidence: 'reference', paidAt: 'x', paidBy: 'u-1', paidReference: 'EFT1', paidOn: '2026-11-25' });
    const { req, res } = mockReqRes({ body: { reference: 'EFT1', paidOn: '2026-11-25' } });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(markPayrollRunPaid).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'co-1', runId: RUN, reference: 'EFT1', paidOn: '2026-11-25',
      actor: expect.objectContaining({ userId: 'u-1', sessionId: 's-1' }),
    }));
  });

  it('file path: an empty body sends neither field', async () => {
    vi.mocked(markPayrollRunPaid).mockResolvedValueOnce({ runId: RUN, status: 'paid', evidence: 'bank_file', paidAt: 'x', paidBy: 'u-1', paidReference: null, paidOn: '2026-11-25' });
    const { req, res } = mockReqRes({ body: undefined });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(markPayrollRunPaid).mock.calls[0]![0]).toMatchObject({ reference: undefined, paidOn: undefined });
  });

  it.each([['viewer'], ['accountant'], ['payroll_clerk']])('%s is refused 403 before the service', async (role) => {
    const { req, res } = mockReqRes({ role });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(markPayrollRunPaid).not.toHaveBeenCalled();
  });

  it('a manager without Payroll Approve is refused 403 before the service', async () => {
    vi.mocked(mayApprove).mockResolvedValueOnce(false);
    const { req, res } = mockReqRes({ role: 'manager' });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(markPayrollRunPaid).not.toHaveBeenCalled();
  });

  it('GET is 405; a bad id and an unknown body field are 400, all before the service', async () => {
    for (const over of [{ method: 'GET' }, { query: { id: 'not-a-uuid' } }, { body: { reference: 'x', paidOn: '2026-11-25', amount: 1 } }]) {
      const { req, res } = mockReqRes(over);
      await handler(req, res);
      expect(res.statusCode).toBe(over.method ? 405 : 400);
    }
    expect(markPayrollRunPaid).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_FOUND', 404], ['ALREADY_PAID', 409], ['JOURNAL_NOT_IN_FORCE', 409], ['NO_PAYMENT_EVIDENCE', 409], ['INVALID_PAID_ON', 400],
  ] as const)('a %s refusal is answered %i with details.reason', async (reason, status) => {
    vi.mocked(markPayrollRunPaid).mockRejectedValueOnce(new PayrollRunMarkPaidRefusal(reason, `refused: ${reason}`));
    const { req, res } = mockReqRes();
    await handler(req, res);
    expect([res.statusCode, reasonOf(res.sent)]).toEqual([status, reason]);
  });

  it('Login-as is 403 IMPERSONATION_FORBIDDEN', async () => {
    vi.mocked(markPayrollRunPaid).mockRejectedValueOnce(new ImpersonationForbiddenError());
    const { req, res } = mockReqRes();
    await handler(req, res);
    expect([res.statusCode, reasonOf(res.sent)]).toEqual([403, 'IMPERSONATION_FORBIDDEN']);
  });

  it('anything else propagates (a 500 rolls the request back)', async () => {
    vi.mocked(markPayrollRunPaid).mockRejectedValueOnce(new Error('boom'));
    const { req, res } = mockReqRes();
    await expect(handler(req, res)).rejects.toThrow('boom');
  });
});
