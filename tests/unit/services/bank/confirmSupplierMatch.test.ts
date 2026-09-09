/**
 * `confirmSupplierInvoiceMatch` — the decisions the supplier arm of
 * bank-match-confirm makes BEFORE it writes, and the one hand-off it makes
 * after.
 *
 * The real posting path is covered by the K-074 integration tests against a
 * live database. What is pinned here is the seam: the validation is run exactly
 * once and its result is handed to the write, so the two cannot disagree and
 * the request transaction does not re-read the line, its status, the period and
 * the bill plan a second time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const VALIDATION = { bankTxId: 'tx-1', paymentAmount: 600, supplierId: 'sup-1' };
const validateBankSupplierPayment = vi.fn(async () => VALIDATION);
const applyBankLineToSupplierInvoices = vi.fn(async () => ({
  supplierPaymentId: 'sp-1', paymentNumber: 'SP-0001', allocatedTotal: 600,
}));
vi.mock('@/modules/accounting/services/ap/supplierBankPaymentService', () => ({
  validateBankSupplierPayment: (...a: unknown[]) => validateBankSupplierPayment(...(a as [])),
  applyBankLineToSupplierInvoices: (...a: unknown[]) => applyBankLineToSupplierInvoices(...(a as [])),
}));

import { confirmSupplierInvoiceMatch } from '@/modules/accounting/services/bank/confirmSupplierMatch';

const COMPANY = 'company-1';
const TX = 'tx-1';
const BILL = 'bill-1';
const USER = 'user-1';

/** One bill, `total` owed, `paid` already settled. */
function bill(total: number, paid = 0) {
  sqlMock.mockResolvedValueOnce([{ id: BILL, total_amount: String(total), amount_paid: String(paid) }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
  validateBankSupplierPayment.mockResolvedValue(VALIDATION);
  applyBankLineToSupplierInvoices.mockResolvedValue({
    supplierPaymentId: 'sp-1', paymentNumber: 'SP-0001', allocatedTotal: 600,
  });
});

describe('confirmSupplierInvoiceMatch', () => {
  it('validates once and hands that same result to the write', async () => {
    bill(600);
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);

    expect(outcome).toEqual({
      ok: true, supplierPaymentId: 'sp-1', paymentNumber: 'SP-0001', allocated: 600,
    });
    expect(validateBankSupplierPayment).toHaveBeenCalledTimes(1);
    // THE POINT: the write is given the validation rather than repeating it.
    // Without this the same eight reads run twice per confirm, and the second
    // pass can see a different world than the one the 4xx decision was made on.
    expect(applyBankLineToSupplierInvoices).toHaveBeenCalledWith(
      COMPANY, expect.objectContaining({ validation: VALIDATION }),
    );
  });

  it('refuses an over-payment before validating anything, naming the excess', async () => {
    bill(600);
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 1000);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/R400\.00 excess/);
    expect(validateBankSupplierPayment).not.toHaveBeenCalled();
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  it('settles a partial payment for exactly the line', async () => {
    bill(600);
    await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 250);
    expect(validateBankSupplierPayment).toHaveBeenCalledWith(
      COMPANY, TX, [{ invoiceId: BILL, amount: 250 }],
    );
  });

  it('reports a missing bill as not_found, distinct from a refusal', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);
    expect(outcome).toEqual({ ok: false, kind: 'not_found' });
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  it('turns a validation refusal into its message, with nothing written', async () => {
    bill(600);
    validateBankSupplierPayment.mockRejectedValueOnce(new Error('is "allocated" and cannot be allocated'));
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);
    expect(outcome).toMatchObject({ ok: false, kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/cannot be allocated/);
    expect(applyBankLineToSupplierInvoices).not.toHaveBeenCalled();
  });

  it('refuses a bill with nothing outstanding', async () => {
    bill(600, 600);
    const outcome = await confirmSupplierInvoiceMatch(COMPANY, TX, BILL, USER, 600);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect((outcome as { message: string }).message).toMatch(/already fully paid/i);
  });
});
