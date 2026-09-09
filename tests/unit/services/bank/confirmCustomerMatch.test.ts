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

const COMPANY = 'company-1';
const TX = 'tx-1';
const INVOICE = 'inv-1';
const USER = 'user-1';

/** One invoice, `total` owed, `paid` already settled. */
function invoice(total: number, paid = 0) {
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
    expect(sqlMock).toHaveBeenCalledTimes(1);
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

  it('reports a missing invoice as not_found, distinct from a refusal', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const outcome = await confirmCustomerInvoiceMatch(COMPANY, TX, INVOICE, USER, 600);
    expect(outcome).toEqual({ ok: false, kind: 'not_found' });
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it('turns a pre-write validation refusal into its message, with nothing written', async () => {
    invoice(600);
    validateBankReceiptApplication.mockRejectedValueOnce(
      new Error('Bank transaction tx-1 is "allocated" and cannot be allocated.'),
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
