/**
 * The FOUR blanket-catch routes that reach a settlement service through an
 * intermediary, and therefore never appeared in a census of the files that
 * import `plan{Receipt,SupplierPayment}Application`.
 *
 * `allocateTransaction` calls `recordSupplierBankPayment` /
 * `autoApplyCustomerReceipt`, which call the plan functions; the three lock
 * helpers raise the same event one row earlier. Each of these routes caught
 * EVERYTHING and answered `badRequest` — 400, the status this codebase reserves
 * for the user's own mistake and monitors as such — while `bank-match-confirm`
 * answered the identical instant of contention 409. `bank-transactions-manual`
 * answered 500, whose text `internalError` replaces with "An internal error
 * occurred", losing the one wording the caller can act on.
 *
 * Both directions are pinned per route: contention → 409 with the retry
 * wording, and a genuine user-error refusal → the route's original status. A
 * guard that only proves the new direction cannot show it stopped there.
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
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  matchTransaction: vi.fn(),
  unmatchTransaction: vi.fn(),
  excludeTransaction: vi.fn(),
  autoMatchTransactions: vi.fn(),
  allocateTransaction: vi.fn(),
  splitAllocateTransaction: vi.fn(),
  deleteTransactions: vi.fn(),
  bulkAcceptTransactions: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  approveSupplierPayment: vi.fn(),
  processSupplierPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierPaymentWorkflowService', () => ({
  voidSupplierPayment: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  confirmCustomerPayment: vi.fn(),
  cancelCustomerPayment: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankReconciliationService';
import { processSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentService';
import { confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import bankAction from '../../../pages/api/accounting/bank-transactions-action';
import bankManual from '../../../pages/api/accounting/bank-transactions-manual';
import supplierAction from '../../../pages/api/accounting/supplier-payments-action';
import customerAction from '../../../pages/api/accounting/customer-payments-action';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '99999999-9999-4999-8999-999999999999';
const TX = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '77777777-7777-4777-8777-777777777777';
const PAYMENT = '88888888-8888-4888-8888-888888888888';

function mockReqRes(body: unknown) {
  const req = {
    method: 'POST', query: {}, body,
    companyId: COMPANY, user: { id: USER },
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

const ALLOCATE_BODY = {
  action: 'allocate', bankTransactionId: TX,
  allocationType: 'account', contraAccountId: ACCOUNT,
};
const MANUAL_BODY = {
  type: 'spend', bankAccountId: ACCOUNT, date: '2026-09-10', amount: 100,
  allocationType: 'account', contraAccountId: ACCOUNT,
};

beforeEach(() => { vi.resetAllMocks(); });

describe('POST /api/accounting/bank-transactions-action', () => {
  // The bank line's own lock — `allocateTransaction`'s first act.
  it('answers a contended BANK LINE 409 with the retry wording', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(new BankTransactionLockTimeoutError(TX));
    const { req, res } = mockReqRes(ALLOCATE_BODY);
    await bankAction(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
  });

  // The transitive edge the census missed: allocateTransaction →
  // recordSupplierBankPayment → planSupplierPaymentApplication → the payment lock.
  it('answers a contended PAYMENT reached through recordSupplierBankPayment 409', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(new PaymentLockTimeoutError(PAYMENT));
    const { req, res } = mockReqRes(ALLOCATE_BODY);
    await bankAction(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
  });

  // And the BILL, raised one call deeper still as a refusal carrying the flag.
  it('answers a contended BILL 409, not the 400 its class would otherwise get', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(
      new SupplierPaymentRefusal('Another request is paying one of these bills — retry in a moment.', { retryable: true }),
    );
    const { req, res } = mockReqRes(ALLOCATE_BODY);
    await bankAction(req, res);

    expect(res.statusCode).toBe(409);
  });

  it('answers a contended INVOICE 409, reached through autoApplyCustomerReceipt', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(
      new ReceiptRefusal('Another request is applying cash to one of these invoices — retry in a moment.', { retryable: true }),
    );
    const { req, res } = mockReqRes(ALLOCATE_BODY);
    await bankAction(req, res);

    expect(res.statusCode).toBe(409);
  });

  // THE OTHER DIRECTION. A books refusal is the caller's own mistake and keeps
  // its 400 — routing contention to 409 must not sweep everything with it.
  it('still answers a NON-retryable refusal 400 with its own message', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(
      new SupplierPaymentRefusal('Bill is cancelled and cannot be paid.'),
    );
    const { req, res } = mockReqRes(ALLOCATE_BODY);
    await bankAction(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/cancelled and cannot be paid/);
  });

  it('still answers a bare Error 400, the behaviour this change did not touch', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(new Error('Bank transaction not found'));
    const { req, res } = mockReqRes(ALLOCATE_BODY);
    await bankAction(req, res);

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/accounting/bank-transactions-manual', () => {
  beforeEach(() => {
    // Step 1 inserts the row; the contention arises in step 2's allocation.
    vi.mocked(sql).mockResolvedValue([{ id: TX }] as never);
  });

  it('answers contention 409 rather than the 500 that hid the retry wording', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(new BankTransactionLockTimeoutError(TX));
    const { req, res } = mockReqRes(MANUAL_BODY);
    await bankManual(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
  });

  it('still answers a genuine fault 500, so the transaction rolls back', async () => {
    vi.mocked(allocateTransaction).mockRejectedValue(new TypeError('cannot read x of undefined'));
    const { req, res } = mockReqRes(MANUAL_BODY);
    await bankManual(req, res);

    expect(res.statusCode).toBe(500);
  });
});

describe('POST /api/accounting/supplier-payments-action', () => {
  it('answers a contended payment 409 with the retry wording', async () => {
    vi.mocked(processSupplierPayment).mockRejectedValue(new PaymentLockTimeoutError(PAYMENT));
    const { req, res } = mockReqRes({ action: 'process', paymentId: PAYMENT });
    await supplierAction(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
  });

  it('still answers a books refusal 400', async () => {
    vi.mocked(processSupplierPayment).mockRejectedValue(
      new SupplierPaymentRefusal('Payment is already processed.'),
    );
    const { req, res } = mockReqRes({ action: 'process', paymentId: PAYMENT });
    await supplierAction(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/already processed/);
  });
});

describe('POST /api/accounting/customer-payments-action', () => {
  it('answers a contended receipt 409 with the retry wording', async () => {
    vi.mocked(confirmCustomerPayment).mockRejectedValue(new PaymentLockTimeoutError(PAYMENT));
    const { req, res } = mockReqRes({ action: 'confirm', paymentId: PAYMENT });
    await customerAction(req, res);

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toMatch(/retry in a moment/i);
  });

  it('still answers a books refusal 400', async () => {
    vi.mocked(confirmCustomerPayment).mockRejectedValue(
      new ReceiptRefusal('Receipt is already confirmed.'),
    );
    const { req, res } = mockReqRes({ action: 'confirm', paymentId: PAYMENT });
    await customerAction(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/already confirmed/);
  });
});
