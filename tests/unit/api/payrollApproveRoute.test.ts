/**
 * POST /api/payroll/runs/[id]/approve (W3-01 review round 2, BRK-596 R2-4):
 * expectedPlanHash is mandatory over HTTP — a caller that omits it would
 * approve whatever the run holds now, not what anyone reviewed. The service
 * parameter stays optional (MCP runs its own dry run). The 409 for a changed
 * run is pinned end to end in tests/integration/brk596-approve-preview.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  withAuth: (h: (req: unknown, res: unknown) => unknown) => (req: Record<string, unknown>, res: unknown) =>
    h(Object.assign(req, { companyId: 'co-A', companyRole: 'admin', user: { id: 'u-1' } }), res),
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ respondIfImpersonationForbidden: () => false }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', async () => {
  const refusal = await import('@/modules/accounting/services/payroll/payrollApprovalRefusal');
  return { ...refusal, approvePayrollRun: vi.fn() };
});

import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';
import handler from '../../../pages/api/payroll/runs/[id]/approve';

const RUN = '44444444-4444-4444-8444-444444444444';

async function post(body: unknown) {
  const req = { method: 'POST', query: { id: RUN }, body, headers: {}, cookies: {} } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, unknown>,
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; }, getHeader() { return undefined; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
    send(p: unknown) { this.sent = p; return this; },
    end() { return this; },
  };
  await handler(req, res as unknown as NextApiResponse);
  return res;
}

// Braces: a returned mock would be run by vitest as the test's cleanup hook (and rethrow the rejection below).
beforeEach(() => { vi.mocked(approvePayrollRun).mockReset(); });

describe('POST /api/payroll/runs/[id]/approve — expectedPlanHash', () => {
  it.each([[undefined], [{}], [{ expectedPlanHash: '' }], [{ expectedPlanHash: ['x'] }], [{ expectedPlanHash: 7 }]])(
    'body %j is a 400 and approval is never attempted', async (body) => {
      expect((await post(body)).statusCode).toBe(400);
      expect(approvePayrollRun).not.toHaveBeenCalled();
    });

  it('passes the hash to the service', async () => {
    vi.mocked(approvePayrollRun).mockResolvedValue({ id: RUN, journalEntryId: 'je-1' } as never);
    expect((await post({ expectedPlanHash: 'h1' })).statusCode).toBe(200);
    expect(approvePayrollRun).toHaveBeenCalledWith('co-A', RUN, 'u-1', { expectedPlanHash: 'h1' });
  });
});

describe('POST /api/payroll/runs/[id]/approve — a deadlock victim', () => {
  it('a raw 40P01 from the approval locks is a retryable 503 with Retry-After, never the driver text', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    vi.mocked(approvePayrollRun).mockImplementation(async () => { throw deadlock; });
    const res = await post({ expectedPlanHash: 'h1' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(JSON.stringify(res.sent)).not.toMatch(/deadlock detected/);
  });
});
