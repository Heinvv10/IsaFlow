/**
 * POST /api/payroll/runs/[id]/calculate must DELIVER the loan refusals, not
 * bury them in a 500.
 *
 * The K-022 loan work added two refusals, both raised before anything is
 * written: `PayrollRunJournalPostedError` when the run still carries a posted
 * GL journal, and `PayrollLoanLockTimeoutError` when a peer holds the loan
 * rows. Both messages tell the caller exactly what to do next ("Reverse the
 * payroll journal first"; "retry in a moment"), and both were reaching
 * `withErrorHandler` as an HTTP 500, so the instruction never arrived.
 *
 * A 4xx is also the correct status for withAuth's COMMIT/ROLLBACK rule: these
 * are refusals with nothing written to unwind. Anything unexpected must still
 * propagate so the status reaches 500 and the request rolls back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: unknown) => h,
  // The real role gate: a viewer must not recalculate (W3-01 review round 1).
  withWriteAccess: (await import('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({
  calculatePayrollRun: vi.fn(),
}));

import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { PayrollRunLockedError } from '@/modules/accounting/services/payroll/payrollRunLock';
import {
  PayrollLoanLockTimeoutError,
  PayrollRunJournalPostedError,
} from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { UnsupportedTaxYearError } from '@/modules/accounting/services/payroll/taxTables';
import handler from '../../../pages/api/payroll/runs/[id]/calculate';

const RUN = '22222222-2222-4222-8222-222222222222';

function mockReqRes(companyRole = 'admin') {
  const req = {
    method: 'POST',
    query: { id: RUN },
    body: {},
    companyId: 'co-1',
    companyRole,
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
});

describe('POST /api/payroll/runs/[id]/calculate — loan refusals', () => {
  it('answers a posted-journal refusal with 400 and the instruction', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValueOnce(new PayrollRunJournalPostedError(RUN));
    const { req, res } = mockReqRes();

    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('Reverse the payroll journal first');
    expect(JSON.stringify(res.sent)).toContain('PAYROLL_RUN_JOURNAL_POSTED');
  });

  it('answers a loan lock timeout with 503 and the retry instruction (D11, was 400)', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValueOnce(new PayrollLoanLockTimeoutError(RUN));
    const { req, res } = mockReqRes();

    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.sent)).toContain('retry in a moment');
    expect(JSON.stringify(res.sent)).toContain('PAYROLL_LOAN_LOCK_TIMEOUT');
  });

  it('still answers the locked-run refusal with 400', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValueOnce(new PayrollRunLockedError('approved'));
    const { req, res } = mockReqRes();

    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('answers an unloaded tax year with 400 and the message, not a 500', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValueOnce(new UnsupportedTaxYearError(2028));
    const { req, res } = mockReqRes();

    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('tax year 2028');
    expect(JSON.stringify(res.sent)).toContain('UNSUPPORTED_TAX_YEAR');
  });

  it('PROPAGATES anything unexpected so the request rolls back', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValueOnce(new Error('engine blew up'));
    const { req, res } = mockReqRes();

    await expect(handler(req, res)).rejects.toThrow('engine blew up');
    expect(res.statusCode).not.toBe(400);
  });
});

describe('POST /api/payroll/runs/[id]/calculate — run id', () => {
  // It reached `::uuid` and came back a 500 carrying the driver's message.
  it.each([['not-a-uuid'], ["x' OR 1=1--"], [['22222222-2222-4222-8222-222222222222', 'x']], [undefined]])(
    'answers a malformed id %j with 400 before anything is calculated', async (id) => {
      const { req, res } = mockReqRes();
      (req as unknown as { query: Record<string, unknown> }).query = { id };
      await handler(req, res);
      expect(res.statusCode).toBe(400);
      expect(calculatePayrollRun).not.toHaveBeenCalled();
    });
});

describe('POST /api/payroll/runs/[id]/calculate — role gate', () => {
  it('refuses a viewer with 403 before anything is calculated', async () => {
    const { req, res } = mockReqRes('viewer');
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(calculatePayrollRun).not.toHaveBeenCalled();
  });
});
