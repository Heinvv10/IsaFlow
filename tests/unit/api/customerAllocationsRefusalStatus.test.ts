/**
 * POST /api/accounting/customer-allocations — how a pre-write throw is
 * classified.
 *
 * The route used to catch everything out of `planReceiptApplication` and answer
 * `badRequest(err.message)`, which put a driver error's raw text in front of the
 * user on a status `withAuth` COMMITs. Narrowing that to the typed
 * `ReceiptRefusal` fixed the disclosure and took a REGRESSION with it: a
 * contended payment row raises `PaymentLockTimeoutError`, which is not a
 * `ReceiptRefusal`, so the re-throw turned "retry in a moment" into a 500 whose
 * text `apiResponse.internalError` replaces with "An internal error occurred".
 *
 * Three outcomes are pinned here, one per class of throw:
 *  - typed refusal      → 400, with the remedy, logged as a refusal not a fault
 *  - lock timeout       → 409, with the retry wording (as `bank-match-confirm`
 *                         answers the parallel bank-line timeout)
 *  - anything else      → rethrown, so withErrorHandler answers 5xx and
 *                         withAuth ROLLBACKs
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
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/receiptApplicationService', () => ({
  planReceiptApplication: vi.fn(),
  applyReceiptPlan: vi.fn(),
}));

import { log } from '@/lib/logger';
import {
  planReceiptApplication,
  applyReceiptPlan,
} from '@/modules/accounting/services/ar/receiptApplicationService';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';
import handler from '../../../pages/api/accounting/customer-allocations';

const PAYMENT = '33333333-3333-4333-8333-333333333333';
const INV_A = '44444444-4444-4444-8444-444444444444';

function mockReqRes() {
  const req = {
    method: 'POST',
    query: {},
    body: { paymentId: PAYMENT, allocations: [{ invoiceId: INV_A, amount: 100 }] },
    companyId: '11111111-1111-4111-8111-111111111111',
    user: { id: '99999999-9999-4999-8999-999999999999' },
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

beforeEach(() => { vi.resetAllMocks(); });

describe('POST /api/accounting/customer-allocations', () => {
  it('answers a typed refusal with 400 and the remedy, and nothing is applied', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValue(
      new ReceiptRefusal(`Invoice ${INV_A} is cancelled and cannot receive a receipt.`),
    );
    const { req, res } = mockReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/cancelled and cannot receive/);
    expect(applyReceiptPlan).not.toHaveBeenCalled();
  });

  it('logs a refusal below error level, so it is not monitored as a fault', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValue(new ReceiptRefusal('nope'));
    const { req, res } = mockReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it('answers a contended payment with 409 and keeps the retry wording', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValue(new PaymentLockTimeoutError(PAYMENT));
    const { req, res } = mockReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
    // Pre-write: the lock is planReceiptApplication's first act, so the 4xx
    // withAuth COMMITs commits an empty transaction.
    expect(applyReceiptPlan).not.toHaveBeenCalled();
  });

  // The half this route used to contradict itself on: a contended INVOICE is
  // raised one call deeper, as a ReceiptRefusal carrying `retryable: true`, and
  // fell through to the 400 four lines below the payment lock's 409.
  it('answers a contended INVOICE 409 too, not just a contended payment', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValue(
      new ReceiptRefusal(
        'Another request is applying cash to one of these invoices — retry in a moment.',
        { retryable: true },
      ),
    );
    const { req, res } = mockReqRes();
    await handler(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
    expect(applyReceiptPlan).not.toHaveBeenCalled();
  });

  it('RETHROWS a driver error rather than answering 400 with its text', async () => {
    const pgErr = Object.assign(
      new Error('column "amount_paid" of relation "customer_invoices" does not exist'),
      { code: '42703' },
    );
    vi.mocked(planReceiptApplication).mockRejectedValue(pgErr);
    const { req, res } = mockReqRes();

    await expect(handler(req, res)).rejects.toThrow(/does not exist/);
    // Never answered: withErrorHandler decides the status, and it is a 5xx, so
    // withAuth ROLLBACKs instead of committing.
    expect(res.statusCode).toBe(0);
    expect(applyReceiptPlan).not.toHaveBeenCalled();
  });

  it('a failure AFTER the plan is never converted to a 4xx', async () => {
    vi.mocked(planReceiptApplication).mockResolvedValue({
      paymentId: PAYMENT, customerId: 'c', lines: [],
      allocatedBefore: 0, allocatedAfter: 100, paymentStatusAfter: 'allocated',
    } as unknown as Awaited<ReturnType<typeof planReceiptApplication>>);
    vi.mocked(applyReceiptPlan).mockRejectedValue(new ReceiptRefusal('post-write race'));
    const { req, res } = mockReqRes();

    await expect(handler(req, res)).rejects.toThrow(/post-write race/);
    expect(res.statusCode).toBe(0);
  });
});
