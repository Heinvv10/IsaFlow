/**
 * GET /api/payroll/runs/[id]/journal-plan (W3-01 review round 1).
 *
 * Runs the route's own chain — withErrorHandler and its role gate — with only
 * withAuth replaced by one that stamps the company and role it would have
 * resolved. The route answers 405 on anything but GET, 400 on a malformed id,
 * 404 when the run is not in the caller's company, and 403 to a role that
 * cannot approve (the preview shows payroll amounts, and only an approver
 * needs it). The real withAuth + RLS path, including another company's run,
 * is in tests/integration/w3-01-payroll-journal-plan-route.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const auth = vi.hoisted(() => ({ role: 'manager' }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    withAuth: (h: (req: unknown, res: unknown) => unknown) => (req: Record<string, unknown>, res: unknown) =>
      h(Object.assign(req, { companyId: 'co-A', companyRole: auth.role }), res),
  };
});
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', () => ({ previewPayrollApproval: vi.fn() }));

import { previewPayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalService';
import handler from '../../../pages/api/payroll/runs/[id]/journal-plan';

const RUN = '33333333-3333-4333-8333-333333333333';

async function call(method: string, id: string) {
  const req = { method, query: { id }, headers: {}, cookies: {} } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    getHeader() { return undefined; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  vi.mocked(previewPayrollApproval).mockReset();
  auth.role = 'manager';
});

describe('GET /api/payroll/runs/[id]/journal-plan', () => {
  it('405 on POST, before the service is asked', async () => {
    expect((await call('POST', RUN)).statusCode).toBe(405);
    expect(previewPayrollApproval).not.toHaveBeenCalled();
  });

  it('400 on a malformed id', async () => {
    expect((await call('GET', 'not-a-uuid')).statusCode).toBe(400);
    expect(previewPayrollApproval).not.toHaveBeenCalled();
  });

  it('404 when the run is not in the caller company, asked with the caller company', async () => {
    vi.mocked(previewPayrollApproval).mockResolvedValue(null);
    expect((await call('GET', RUN)).statusCode).toBe(404);
    expect(previewPayrollApproval).toHaveBeenCalledWith('co-A', RUN);
  });

  it.each(['owner', 'admin', 'manager'])('200 with the preview for %s', async (role) => {
    auth.role = role;
    vi.mocked(previewPayrollApproval).mockResolvedValue({ plan: { runId: RUN }, blocker: null } as never);
    const res = await call('GET', RUN);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.sent)).toContain(RUN);
  });

  it.each(['viewer', 'technician', 'storeman'])('403 for %s, before the service is asked', async (role) => {
    auth.role = role;
    vi.mocked(previewPayrollApproval).mockResolvedValue({ plan: { runId: RUN }, blocker: null } as never);
    expect((await call('GET', RUN)).statusCode).toBe(403);
    expect(previewPayrollApproval).not.toHaveBeenCalled();
  });
});
