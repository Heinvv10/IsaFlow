/**
 * `bank-match-confirm` maps a SERVICE THROW to an HTTP status, and the mapping
 * is a correctness property, not presentation.
 *
 * `withAuth` decides COMMIT vs ROLLBACK on `statusCode >= 500`. So every
 * refusal decided BEFORE the first write must come back 4xx — nothing is
 * written, and a 500 would tell the user "an internal error occurred" for a
 * message that names the remedy — while every throw at or after the first
 * write must come back 500, because the route has posted a journal and touched
 * `bank_transactions` and the transaction has to unwind.
 *
 * THE REFUND REFUSAL WAS ON THE WRONG SIDE OF THAT LINE. `planSupplierRefund`
 * runs its whole on-account-credit check before `createJournalEntry`, but the
 * route answered 400 only for `isBankAllocationRefusal`, so an over-credit
 * refund from the bank-match screen fell through to the 500 fallback. These
 * tests pin each class to its status so the next one added is not silently
 * swept into the fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlFn(...a),
  withTransaction: vi.fn(),
  withSavepoint: (_n: string, fn: () => unknown) => fn(),
}));

vi.mock('@/modules/accounting/services/bank/confirmSupplierMatch', () => ({
  confirmSupplierInvoiceMatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/confirmCustomerMatch', () => ({
  confirmCustomerInvoiceMatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  allocateTransaction: vi.fn(),
  matchTransaction: vi.fn(),
}));

import {
  confirmSupplierInvoiceMatch,
} from '@/modules/accounting/services/bank/confirmSupplierMatch';
import { SupplierRefundRefusal } from '@/modules/accounting/services/ap/supplierRefundDocument';
import {
  BankAllocationRefusal,
} from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';
import handler from '../../../pages/api/accounting/bank-match-confirm';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '77777777-7777-4777-8777-777777777777';
const TX = '33333333-3333-4333-8333-333333333333';
const CANDIDATE = '55555555-5555-4555-8555-555555555555';

/** The two reads the route makes before it reaches the branch under test. */
function primeRouteReads(): void {
  sqlFn
    // Money OUT against a supplier bill: the only direction this candidate
    // type admits. A money-IN line here is refused by `signMismatchReason`
    // before the branch runs, so it could not reach the mapping under test.
    // The refusal classes below are thrown by the mocked service, so the
    // line's own direction is fixture, not subject.
    .mockResolvedValueOnce([{
      id: TX, amount: -1150, transaction_date: '2026-09-08',
      status: 'imported', feed_state: 'posted',
    }])
    .mockResolvedValue([]);
}

interface Captured { statusCode: number; body: unknown }

async function callRoute(): Promise<Captured> {
  const state: Captured = { statusCode: 0, body: undefined };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  const req = {
    method: 'POST',
    body: { bankTransactionId: TX, candidateType: 'supplier_invoice', candidateId: CANDIDATE },
    companyId: COMPANY,
    user: { id: USER },
  };
  await (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlFn.mockReset();
});

describe('bank-match-confirm — refusal to status', () => {
  it('answers 400 for an over-credit REFUND, not 500', async () => {
    // Remove `isSupplierRefundRefusal` from the route and this goes red at 500
    // — which is what the screen showed: "An internal error occurred", for a
    // refusal whose message names the supplier, both amounts and the remedy.
    primeRouteReads();
    vi.mocked(confirmSupplierInvoiceMatch).mockRejectedValue(
      new SupplierRefundRefusal(
        'A refund of 1150.00 exceeds the 0.00 Acme has on account as at 2026-09-08.',
      ),
    );

    const out = await callRoute();
    expect(out.statusCode).toBe(400);
    expect(JSON.stringify(out.body)).toContain('exceeds the 0.00');
  });

  it('still answers 400 for a bank allocation refusal', async () => {
    primeRouteReads();
    vi.mocked(confirmSupplierInvoiceMatch).mockRejectedValue(
      new BankAllocationRefusal('Transaction already allocated — cannot allocate'),
    );
    expect((await callRoute()).statusCode).toBe(400);
  });

  it('answers 503 for contention, which is retryable and wrote nothing (D11, was 409)', async () => {
    primeRouteReads();
    vi.mocked(confirmSupplierInvoiceMatch).mockRejectedValue(
      new PaymentLockTimeoutError(CANDIDATE),
    );
    expect((await callRoute()).statusCode).toBe(503);
  });

  it('still answers 500 for an unclassified throw, so the transaction unwinds', async () => {
    // The fallback must stay a fallback. A throw the route cannot classify may
    // have happened after the first write, and `withAuth` rolls back only at
    // 500 — answering 4xx here would COMMIT a half-finished match.
    primeRouteReads();
    vi.mocked(confirmSupplierInvoiceMatch).mockRejectedValue(new Error('column does not exist'));
    expect((await callRoute()).statusCode).toBe(500);
  });
});
