/**
 * POST /api/accounting/recurring-transactions-execute must not answer 4xx
 * after it has written.
 *
 * `withAuth` COMMITs the request transaction on a 4xx and ROLLBACKs only on a
 * 5xx. The route used to catch EVERYTHING and return `badRequestFromError`, so
 * a run that failed halfway had its partial writes committed — and a failure on
 * the invoice number silently threw the reservation away, leaving the next run
 * to reserve the same number and fail identically, forever.
 *
 * Only the pre-write failure — the template does not exist or is inactive —
 * may be answered with a 4xx. Everything else must propagate to
 * `withErrorHandler` and become a 500.
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
vi.mock('@/modules/accounting/services/core/recurringTransactionService', () => ({
  executeRecurring: vi.fn(),
}));

import { executeRecurring } from '@/modules/accounting/services/core/recurringTransactionService';
import {
  RecurringTemplateNotDueError,
  RecurringTemplateNotFoundError,
} from '@/modules/accounting/services/core/recurringTransactionErrors';
import { RecurringTemplateLockTimeoutError } from '@/modules/accounting/services/core/recurringTemplateLock';
import handler from '../../../pages/api/accounting/recurring-transactions-execute';

const mockExecute = executeRecurring as unknown as ReturnType<typeof vi.fn>;

function makeRes() {
  const res = { statusCode: 200 } as unknown as NextApiResponse & { body?: unknown };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = vi.fn((b: unknown) => { (res as { body?: unknown }).body = b; return res; }) as never;
  return res;
}

const post = () => ({
  method: 'POST',
  user: { id: 'u1' },
  companyId: 'c1',
  body: { templateId: 't1' },
} as unknown as NextApiRequest);

describe('recurring-transactions-execute error mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers 404 for the pre-write "no such active template" failure', async () => {
    mockExecute.mockRejectedValueOnce(new RecurringTemplateNotFoundError('t1'));
    const res = makeRes();
    await handler(post() as never, res as never);
    expect(res.statusCode).toBe(404);
  });

  it('propagates any other failure so the request transaction rolls back', async () => {
    const dbError = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockExecute.mockRejectedValueOnce(dbError);
    const res = makeRes();
    await expect(handler(post() as never, res as never)).rejects.toBe(dbError);
    // Nothing was answered, so nothing was committed by a 4xx.
    expect(res.json).not.toHaveBeenCalled();
  });

  it('answers 409 when the schedule has not come round — the double-click answer', async () => {
    // Raised by the template row lock BEFORE the first INSERT, so the 4xx
    // COMMIT is a commit of nothing.
    mockExecute.mockRejectedValueOnce(new RecurringTemplateNotDueError('t1', '2026-09-10'));
    const res = makeRes();
    await handler(post() as never, res as never);
    expect.soft(res.statusCode).toBe(409);
    expect((res as { body?: { error?: { details?: unknown } } }).body?.error?.details)
      .toEqual({ nextRunDate: '2026-09-10' });
  });

  it('answers 409 when another request holds the template row past lock_timeout', async () => {
    mockExecute.mockRejectedValueOnce(new RecurringTemplateLockTimeoutError('t1'));
    const res = makeRes();
    await handler(post() as never, res as never);
    expect(res.statusCode).toBe(409);
  });

  it('still succeeds normally', async () => {
    mockExecute.mockResolvedValueOnce({ entityType: 'customer_invoice', entityId: 'i1', posted: false });
    const res = makeRes();
    await handler(post() as never, res as never);
    expect(res.statusCode).toBe(200);
  });
});
