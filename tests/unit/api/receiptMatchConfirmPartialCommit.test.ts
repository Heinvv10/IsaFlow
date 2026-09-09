// RED phase — written before the route was split into pre-write and post-write halves.
/**
 * POST /api/accounting/ar/receipt-match/confirm must not COMMIT an allocation
 * it is about to report as a failure.
 *
 * The route wrapped the whole of `confirmReceiptMatch` in one try/catch and
 * decided 400-vs-500 by regex-matching the error message. That was safe while
 * every refusal preceded `allocateTransaction`. It stopped being safe when
 * `confirmReceiptMatch` was widened to take an allocations array: it now calls
 * `planReceiptApplication` a SECOND time, after the journal has posted, as a
 * race guard — and that call throws the very message shapes the regex matches
 * ("not found", "already allocated", "exceeds", "different customer").
 *
 * `withAuth` decides COMMIT vs ROLLBACK on `res.statusCode >= 500`, so a 4xx
 * COMMITS. A genuine race therefore posted the journal, flipped the bank
 * transaction to `allocated`, committed both, and told the caller nothing had
 * happened. The money moved and the response said it had not.
 *
 * THE RULE THESE PIN, and it is the same one the MCP tool already follows:
 * only PRE-WRITE validation may become a 400. Once a service that can write has
 * been called, every failure must propagate so the status reaches 500 and
 * withAuth rolls back. The same rule is pinned for the chart-of-accounts PUT in
 * chartOfAccountsPutPartialCommit.test.ts — same defect class, same remedy.
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
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', () => ({
  validateBankReceiptApplication: vi.fn(),
  confirmReceiptMatch: vi.fn(),
}));

import {
  validateBankReceiptApplication,
  confirmReceiptMatch,
} from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import handler from '../../../pages/api/accounting/ar/receipt-match/confirm';

const BANK_TX = '66666666-6666-4666-8666-666666666666';
const INV_A = '44444444-4444-4444-8444-444444444444';

function mockReqRes(body: Record<string, unknown>) {
  const req = {
    method: 'POST',
    query: {},
    body,
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

const BODY = { bankTxId: BANK_TX, customerInvoiceId: INV_A, amount: 600 };

const OK_VALIDATION = {
  bankTxId: BANK_TX,
  receiptAmount: 1000,
  transactionDate: '2026-03-01',
  customerId: '22222222-2222-4222-8222-222222222222',
  lines: [],
  allocatedTotal: 600,
  unappliedRemainder: 400,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('POST /api/accounting/ar/receipt-match/confirm', () => {
  it('A PRE-WRITE REFUSAL IS A 400 — nothing was written and the reason is actionable', async () => {
    vi.mocked(validateBankReceiptApplication).mockRejectedValue(
      new ReceiptRefusal(`Invoice ${INV_A} not found`),
    );
    const { req, res } = mockReqRes(BODY);
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toMatch(/not found/i);
    // The posting service was never reached.
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it.each([
    ['a race that reads as not found', `Invoice ${INV_A} not found`],
    ['a race that reads as already allocated', 'This receipt is already allocated against invoice INV0001.'],
    ['a race that reads as an overallocation', 'R600.00 exceeds the R100.00 outstanding on invoice INV0001.'],
    ['a race on the counterparty', 'Invoice INV0001 belongs to a different customer than this receipt.'],
  ])(
    'A POST-WRITE FAILURE PROPAGATES — %s must not become a 400',
    async (_label, message) => {
      // Validation passed, so allocateTransaction ran and the journal posted.
      // Everything after that point must reach withAuth as a 5xx, or the
      // journal is COMMITTED while the caller is told the request failed.
      vi.mocked(validateBankReceiptApplication).mockResolvedValue(OK_VALIDATION);
      vi.mocked(confirmReceiptMatch).mockRejectedValue(new Error(message));

      const { req, res } = mockReqRes(BODY);
      await expect(handler(req, res)).rejects.toThrow(message);
      // Critically: NOT a 400. A 4xx here is what COMMITs the posted journal.
      expect(res.statusCode).not.toBe(400);
    },
  );

  it('does not surface a driver error as a caller-actionable 400', async () => {
    // A SQLSTATE-carrying error is not an application refusal; leaking it would
    // also put schema names in a response.
    const pgError = Object.assign(new Error('relation "customer_payments" does not exist'), {
      code: '42P01',
    });
    vi.mocked(validateBankReceiptApplication).mockRejectedValue(pgError);
    const { req, res } = mockReqRes(BODY);
    await expect(handler(req, res)).rejects.toThrow();
    expect(res.statusCode).not.toBe(400);
  });

  // The classifier's OTHER direction, and why it is typed rather than
  // "carries no SQLSTATE code": a TypeError raised inside the validation is
  // equally code-less. Under the old predicate its text was handed to the user
  // verbatim as a 400 — a status withAuth COMMITs, monitored as their mistake.
  it('does not surface a code-less internal bug as a caller-actionable 400', async () => {
    vi.mocked(validateBankReceiptApplication).mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'total_amount')"),
    );
    const { req, res } = mockReqRes(BODY);
    await expect(handler(req, res)).rejects.toThrow(/total_amount/);
    expect(res.statusCode).not.toBe(400);
  });

  it('succeeds on the single-invoice body the receipt-match screen still sends', async () => {
    vi.mocked(validateBankReceiptApplication).mockResolvedValue(OK_VALIDATION);
    vi.mocked(confirmReceiptMatch).mockResolvedValue({
      ...OK_VALIDATION,
      journalEntryId: 'je-1',
      customerPaymentId: 'pay-1',
      paymentStatus: 'confirmed',
    });
    const { req, res } = mockReqRes(BODY);
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(confirmReceiptMatch).mock.calls[0]![1].allocations)
      .toEqual([{ invoiceId: INV_A, amount: 600 }]);
  });

  it('accepts the multi-invoice allocations body', async () => {
    vi.mocked(validateBankReceiptApplication).mockResolvedValue(OK_VALIDATION);
    vi.mocked(confirmReceiptMatch).mockResolvedValue({
      ...OK_VALIDATION,
      journalEntryId: 'je-1',
      customerPaymentId: 'pay-1',
      paymentStatus: 'confirmed',
    });
    const { req, res } = mockReqRes({
      bankTxId: BANK_TX,
      allocations: [
        { invoiceId: INV_A, amount: 600 },
        { invoiceId: '4b444444-4444-4444-8444-444444444444', amount: 400 },
      ],
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(confirmReceiptMatch).mock.calls[0]![1].allocations).toHaveLength(2);
  });

  it('rejects a body naming both shapes rather than guessing', async () => {
    const { req, res } = mockReqRes({
      bankTxId: BANK_TX,
      customerInvoiceId: INV_A,
      amount: 600,
      allocations: [{ invoiceId: INV_A, amount: 600 }],
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(validateBankReceiptApplication).not.toHaveBeenCalled();
  });
});
