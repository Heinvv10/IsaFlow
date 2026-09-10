/**
 * `confirmCustomerInvoiceMatch` — the decisions the customer arm of
 * bank-match-confirm makes BEFORE it writes, and the one hand-off it makes
 * after.
 *
 * The real posting path is covered by the K-074 customer integration tests
 * against a live database. What is pinned here is the seam: every refusal is
 * decided from reads, and the settlement goes to `confirmReceiptMatch` rather
 * than to a bare `amount_paid` UPDATE — the write that no reversal can undo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
// `lockBankTransactionForUpdate` refuses to run outside a request transaction —
// its `FOR UPDATE` would be released at the end of its own statement and
// protect nothing. Stand in for the withAuth-bound client so the real lock
// helper runs and its 5s `SET LOCAL lock_timeout` is observable.
const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    queries: [] as string[],
    present: true,
    client: { query: (t: string) => { mockTx.queries.push(t); return Promise.resolve(undefined); } },
  },
}));
vi.mock('@/lib/als', async () => {
  const actual = await vi.importActual<typeof import('@/lib/als')>('@/lib/als');
  return {
    ...actual,
    als: { ...actual.als, getStore: () => (mockTx.present ? { client: mockTx.client } : undefined) },
  };
});
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const validateBankReceiptApplication = vi.fn(async () => ({}));
const confirmReceiptMatch = vi.fn(async () => ({
  customerPaymentId: 'cp-1', allocatedTotal: 600,
}));
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', () => ({
  validateBankReceiptApplication: (...a: unknown[]) => validateBankReceiptApplication(...(a as [])),
  confirmReceiptMatch: (...a: unknown[]) => confirmReceiptMatch(...(a as [])),
}));

import { confirmCustomerInvoiceMatch } from '@/modules/accounting/services/bank/confirmCustomerMatch';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import {
  planAllocationLines,
  type ReceiptAllocationInput,
} from '@/modules/accounting/services/ar/receiptAllocationLines';

const COMPANY = 'company-1';
const TX = 'tx-1';
const INVOICE = 'inv-1';
const USER = 'user-1';

/**
 * The bank line's own `FOR UPDATE` read, now the arm's FIRST statement — see
 * the lock-order note in `confirmCustomerMatch.ts`. Every fixture enqueues it
 * before the invoice, or the queue hands each row to the wrong read.
 */
function bankLine() {
  sqlMock.mockResolvedValueOnce([{ id: TX, status: 'imported' }]);
}

/** One invoice, `total` owed, `paid` already settled, behind its bank line. */
function invoice(total: number, paid = 0) {
  bankLine();
  sqlMock.mockResolvedValueOnce([{
    id: INVOICE, total_amount: String(total), amount_paid: String(paid),
  }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
  validateBankReceiptApplication.mockResolvedValue({});
  confirmReceiptMatch.mockResolvedValue({ customerPaymentId: 'cp-1', allocatedTotal: 600 });
});

describe('confirmCustomerInvoiceMatch', () => {
  it('settles through confirmReceiptMatch, never a bare amount_paid write', async () => {
    invoice(600);
    const outcome = await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600);

    expect(outcome).toEqual({ ok: true, customerPaymentId: 'cp-1', allocated: 600 });
    // THE POINT: the settlement is an ALLOCATION against a receipt document, so
    // `bankAllocationUnwind` can reverse it. The branch this replaces wrote
    // `customer_invoices.amount_paid` absolutely with no allocation row, and a
    // reversal then returned the credit to AR control while the invoice kept
    // reading as paid.
    expect(confirmReceiptMatch).toHaveBeenCalledWith(COMPANY, {
      bankTxId: TX, userId: USER, allocations: [{ invoiceId: INVOICE, amount: 600 }],
    });
    // One UPDATE on customer_invoices here would be the defect coming back.
    // Two reads: the bank line's lock, then the invoice. Nothing else.
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('allocates exactly the line on a partial receipt', async () => {
    invoice(600);
    await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 250);
    expect(confirmReceiptMatch).toHaveBeenCalledWith(COMPANY, expect.objectContaining({
      allocations: [{ invoiceId: INVOICE, amount: 250 }],
    }));
  });

  it('refuses an over-payment before validating anything, naming the excess', async () => {
    invoice(600);
    const outcome = await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 1000);

    expect(outcome).toMatchObject({ ok: false, kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/R400\.00 excess/);
    expect(validateBankReceiptApplication).not.toHaveBeenCalled();
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it('refuses an invoice with nothing outstanding', async () => {
    invoice(600, 600);
    const outcome = await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/already fully paid/i);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  // MEDIUM-1 (round 7). The invoice lock (`FOR UPDATE OF ci`, inside
  // `fetchInvoiceCandidates`) used to be this arm's first row lock, so the
  // order was customer_invoices → bank_transactions while
  // `allocateTransaction`, `splitAllocateTransaction` and
  // `reverseReconciledTransaction` all take bank_transactions first. Two
  // requests naming the same (line, invoice) pair from the two directions hold
  // one row each and deadlock — 40P01, which `withAuth` answers 500.
  it('locks the bank line BEFORE it reads the invoice — the canonical order', async () => {
    invoice(600);
    await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600);

    const texts = sqlMock.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(texts[0]).toMatch(/FROM bank_transactions[\s\S]*FOR UPDATE/);
    expect(texts[1]).toMatch(/FROM customer_invoices/);
    expect(mockTx.queries).toContain("SET LOCAL lock_timeout = '5s'");
  });

  // The lock is taken for its ORDER, not for the decision: a vanished line is
  // still refused by the validator's own not-found wording, never turned into
  // an early not_found naming the invoice.
  it('leaves a vanished bank line to the validator rather than reporting the invoice missing', async () => {
    sqlMock.mockResolvedValueOnce([]);                 // bank line gone
    sqlMock.mockResolvedValueOnce([{ id: INVOICE, total_amount: '600', amount_paid: '0' }]);
    validateBankReceiptApplication.mockRejectedValueOnce(
      new ReceiptRefusal(`Bank transaction ${TX} not found`) as never,
    );
    const outcome = await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/Bank transaction .* not found/);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it('reports a missing invoice as not_found, distinct from a refusal', async () => {
    bankLine();
    sqlMock.mockResolvedValueOnce([]);
    const outcome = await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600);
    expect(outcome).toEqual({ ok: false, kind: 'not_found' });
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it('turns a pre-write validation refusal into its message, with nothing written', async () => {
    invoice(600);
    validateBankReceiptApplication.mockRejectedValueOnce(
      new ReceiptRefusal('Bank transaction tx-1 is "allocated" and cannot be allocated.'),
    );
    const outcome = await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600);
    expect(outcome).toMatchObject({ ok: false, kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/cannot be allocated/);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  // The refusal's MIRROR. Catching every throw would classify an infrastructure
  // failure as the user's fault: the route answers a refusal with
  // `apiResponse.badRequest`, which passes the message straight to the client,
  // so raw Postgres text would reach the browser on a status `withAuth` COMMITs.
  // MEDIUM-2 (round 9), the AR twin. Contention on the INVOICE was answered 400
  // while the same instant of contention on the bank LINE answered 409 —
  // because `fetchInvoiceCandidates` raises its lock timeout as a
  // `ReceiptRefusal`, the same class every books refusal uses. `retryable`
  // separates them; `kind:'contended'` is what the route answers 409.
  //
  // The real `planAllocationLines` runs and the DB read is stubbed with the
  // 55P03 our own 5s budget produces, so the flag's own site is exercised.
  it('reports lock contention on the invoice as contended, not as a refusal', async () => {
    invoice(1000);
    validateBankReceiptApplication.mockImplementationOnce(
      (async (companyId: string, _txId: string, allocations: ReceiptAllocationInput[]) =>
        planAllocationLines(companyId, allocations, { paymentId: null, customerId: null })
      ) as unknown as () => Promise<unknown>,
    );
    sqlMock.mockRejectedValueOnce(Object.assign(
      new Error('canceling statement due to lock timeout'), { code: '55P03' },
    ));

    const outcome = await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600);
    expect(outcome).toMatchObject({ ok: false, kind: 'contended' });
    expect((outcome as { message: string }).message).toMatch(/retry in a moment/i);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it('re-throws an infrastructure failure instead of reporting it as a refusal', async () => {
    invoice(600);
    validateBankReceiptApplication.mockRejectedValueOnce(Object.assign(
      new Error('current transaction is aborted, commands ignored until end of transaction block'),
      { code: '25P02' },
    ));

    await expect(confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600))
      .rejects.toThrow(/aborted/);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  // The same mirror, for a fault that carries NO code at all. "Code-less" used
  // to be the whole test for a refusal, and a TypeError satisfies it — the
  // caller would have answered `badRequest(err.message)` with internal text.
  it('re-throws a code-less internal bug instead of reporting it as a refusal', async () => {
    invoice(600);
    validateBankReceiptApplication.mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'amount')"),
    );

    await expect(confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600))
      .rejects.toThrow(TypeError);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  // Post-write. A refusal shape raised by `confirmReceiptMatch`'s own race guard
  // arrives AFTER the journal has posted, so it must NOT be converted into a
  // 4xx here — `withAuth` would COMMIT the journal behind a failure response.
  it('propagates a throw from confirmReceiptMatch rather than converting it to a refusal', async () => {
    invoice(600);
    confirmReceiptMatch.mockRejectedValueOnce(new Error('Invoice INV-1 not found'));
    await expect(confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600))
      .rejects.toThrow(/not found/);
  });
});
