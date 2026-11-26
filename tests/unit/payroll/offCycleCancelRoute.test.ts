/**
 * Review L3 of 819c2861c0 / L-c, L-d of 87708dc593: cancelling an off-cycle run whose pending approval request is held past
 * the lock budget answers as approval-requests does (503 + Retry-After, the lock's code), and one no longer pending
 * answers 404 with a code; never a 500. The race itself, through the real lock, is in
 * tests/integration/w6-oc-cancel.int.test.ts; here the route's mapping of the two errors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h, withWriteAccess: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: H) => h }));
vi.mock('@/lib/auth/withPayrollModule', () => ({ withPayrollModule: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/approvePermissionResponse', () => ({ refuseWithoutApprove: vi.fn(async () => false) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunCancel', () => ({ cancelOffCycleRun: vi.fn() }));

import { cancelOffCycleRun } from '@/modules/accounting/services/payroll/payrollRunCancel';
import { ApprovalRequestNotFoundError } from '@/modules/accounting/services/gl/approvalAuthority';
import { ApprovalRequestLockTimeoutError } from '@/modules/accounting/services/gl/approvalRequestLock';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/payroll/runs/[id]/cancel';

const RUN = '22222222-2222-4222-8222-222222222222';
async function call() {
  const req = { method: 'POST', query: { id: RUN }, headers: {}, cookies: {}, companyId: 'co', companyRole: 'owner', user: { id: 'u-1' } };
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, unknown>,
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; }, getHeader() { return undefined; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  await (handler as H)(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => { vi.mocked(cancelOffCycleRun).mockReset(); });

describe('POST /api/payroll/runs/[id]/cancel: a request decided or held elsewhere', () => {
  it('no longer pending (decided, or gone): 404 with code APPROVAL_REQUEST_NOT_FOUND, neutral wording', async () => {
    vi.mocked(cancelOffCycleRun).mockRejectedValue(new ApprovalRequestNotFoundError('r-1'));
    const res = await call();
    expect(res.statusCode).toBe(404);
    expect(res.sent).toMatchObject({ error: { code: 'NOT_FOUND', details: { code: 'APPROVAL_REQUEST_NOT_FOUND' } } });
    expect(JSON.stringify(res.sent)).toMatch(/no longer pending/);
    expect(JSON.stringify(res.sent)).not.toMatch(/someone else/);
  });
  it('held past the lock budget: 503 + Retry-After with the lock\'s code', async () => {
    vi.mocked(cancelOffCycleRun).mockRejectedValue(new ApprovalRequestLockTimeoutError('r-1'));
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(res.sent).toMatchObject({ error: { details: { code: 'APPROVAL_REQUEST_LOCK_TIMEOUT' } } });
    expect(JSON.stringify(res.sent)).toMatch(/being changed by another request/);
  });
  it('the canceller\'s id is passed through (no null branch, review L2)', async () => {
    vi.mocked(cancelOffCycleRun).mockResolvedValue(null);
    expect((await call()).statusCode).toBe(404);
    expect(cancelOffCycleRun).toHaveBeenCalledWith('co', RUN, 'u-1');
  });
});
