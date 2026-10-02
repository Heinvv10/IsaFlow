/**
 * R-181 (PR #618 review at 72b132f52, M1): the WIRING of recordGatewayInvoiceReceipt, in CI.
 * The money rules are pinned in gatewaySettlementRules.test.ts; this pins that the service hands
 * them the right figures: the receipt INSERT's total, the fee leg given to postGatewayFee (on the
 * dedupe path costed against what the FIRST report banked), and the non-ZAR hold. The database,
 * the GL posting, the fee posting and the invoice-locked allocation are mocked; the invoice lock
 * itself is proven only by the r181 integration race test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { text: string; values: unknown[] }[],
  already: null as null | Record<string, unknown>,
  /** What the invoice-locked allocation decides; null = the default (min of receipt and R115). */
  allocated: null as null | number,
  block: null as null | string,
  clientId: null as null | string,
}));
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    h.calls.push({ text, values });
    if (text.includes('FROM customer_payments') && text.includes('bank_reference')) return Promise.resolve(h.already ? [h.already] : []);
    if (text.includes('FROM customer_invoices')) return Promise.resolve([{ client_id: CUSTOMER, created_by: USER }]);
    if (text.includes('company_users')) return Promise.resolve([{ user_id: USER }]);
    return Promise.resolve([]);
  },
  withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerPaymentAllocationService', () => ({
  confirmCustomerPayment: vi.fn(async () => ({ glJournalEntryId: 'je-1' })),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn(async () => ({ id: 'bank-1' })) }));
vi.mock('@/modules/accounting/services/ar/gatewayFeeService', () => ({ postGatewayFee: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/ar/portalLinkCharge', () => ({ spendPaymentLinkOfRequest: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/ar/gatewayReceiptAllocation', () => ({
  decideGatewayAllocation: vi.fn(async (_c: string, _i: string, amountRand: number, _r: string, hold: string | null) => ({
    allocated: hold || h.block ? 0 : (h.allocated ?? Math.min(amountRand, 115)), invoiceBlock: hold ?? h.block, overpaid: false,
    clientId: h.clientId ?? CUSTOMER, status: 'sent', deleted: false,
  })),
}));
vi.mock('@/modules/accounting/services/ar/gatewaySettlementReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/ar/gatewaySettlementReview')>()),
  flagSettlementForReview: vi.fn(async () => undefined),
}));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

import { recordGatewayInvoiceReceipt } from '@/modules/accounting/services/ar/gatewayInvoiceReceiptService';
import { postGatewayFee } from '@/modules/accounting/services/ar/gatewayFeeService';
import { decideGatewayAllocation } from '@/modules/accounting/services/ar/gatewayReceiptAllocation';
import { flagSettlementForReview } from '@/modules/accounting/services/ar/gatewaySettlementReview';

const fee = postGatewayFee as unknown as ReturnType<typeof vi.fn>;
const allocate = decideGatewayAllocation as unknown as ReturnType<typeof vi.fn>;
const flag = flagSettlementForReview as unknown as ReturnType<typeof vi.fn>;
const reasons = () => flag.mock.calls.map((c) => c[2] as string[]);
const receiptInsert = () => h.calls.find((c) => c.text.includes('INSERT INTO customer_payments ('));
const base = { companyId: '33333333-3333-4333-8333-333333333333', invoiceId: '44444444-4444-4444-8444-444444444444',
  reference: 'r181_wiring', requestedCents: 11500 };

const allocationInsert = () => h.calls.find((c) => c.text.includes('INSERT INTO customer_payment_allocations'));

beforeEach(() => {
  h.calls.length = 0; h.already = null; h.allocated = null; h.block = null; h.clientId = null;
  fee.mockClear(); allocate.mockClear(); flag.mockClear();
});

describe('recordGatewayInvoiceReceipt wiring', () => {
  it('pass-on fee: banks requested_amount, hands postGatewayFee no fee (the customer paid it)', async () => {
    await recordGatewayInvoiceReceipt({ ...base, feeRand: 3.5,
      reported: { amountCents: 11850, currency: 'ZAR', requestedAmountCents: 11500, feeCents: 350 } });
    expect(receiptInsert()!.values[4]).toBe(115);
    expect(fee.mock.calls[0]![0]).toMatchObject({ feeRand: 0 });
    expect(allocate.mock.calls[0]!.slice(2)).toEqual([115, 'r181_wiring', null]);
  });

  it('merchant-borne fee: banks R115 and posts the R3.50 fee', async () => {
    await recordGatewayInvoiceReceipt({ ...base, feeRand: 3.5,
      reported: { amountCents: 11500, currency: 'ZAR', requestedAmountCents: 11500, feeCents: 350 } });
    expect(receiptInsert()!.values[4]).toBe(115);
    expect(fee.mock.calls[0]![0]).toMatchObject({ feeRand: 3.5 });
  });

  it('non-ZAR: banked, held unapplied, and no fee posted as rand', async () => {
    await recordGatewayInvoiceReceipt({ ...base, feeRand: 3.5, reported: { amountCents: 11500, currency: 'USD' } });
    expect(receiptInsert()!.values[4]).toBe(115);
    expect(allocate.mock.calls[0]![4]).toBe('unapplied_currency');
    expect(fee.mock.calls[0]![0]).toMatchObject({ feeRand: null });
  });

  it('dedupe: no receipt INSERT; the fee is costed against what the FIRST report banked (R118.50)', async () => {
    h.already = { id: 'p-1', created_by: USER, bank_account_id: 'bank-1', payment_date: '2026-10-02',
      total_amount: '118.50', description: 'Paystack card payment r181_wiring' };
    await recordGatewayInvoiceReceipt({ ...base, feeRand: 3.5,
      reported: { amountCents: 11850, currency: 'ZAR', requestedAmountCents: 11500, feeCents: 350 } });
    expect(receiptInsert()).toBeUndefined();
    expect(allocate).not.toHaveBeenCalled();
    expect(fee.mock.calls[0]![0]).toMatchObject({ feeRand: 3.5 });
  });

  it('dedupe after verify trusted requested_amount (R115 banked, amount R118.50 tagged): the customer-paid fee posts nothing', async () => {
    h.already = { id: 'p-1', created_by: USER, bank_account_id: 'bank-1', payment_date: '2026-10-02',
      total_amount: '115.00', description: 'Paystack card payment r181_wiring [paystack amount 11850 cents]' };
    await recordGatewayInvoiceReceipt({ ...base, feeRand: 3.5,
      reported: { amountCents: 11850, currency: 'ZAR', requestedAmountCents: 11500, feeCents: 350 } });
    // Bank: R115 receipt - R0 = R115, what Paystack deposits (R118.50 - R3.50). The raw R3.50 would net R111.50.
    expect(fee.mock.calls[0]![0]).toMatchObject({ feeRand: 0 });
  });

  it('the allocation INSERT carries what the locked invoice can take (R50), not the whole receipt (R115)', async () => {
    h.allocated = 50;
    await recordGatewayInvoiceReceipt({ ...base, feeRand: null, reported: { amountCents: 11500, currency: 'ZAR' } });
    expect(receiptInsert()!.values[4]).toBe(115);
    expect(allocationInsert()!.values[2]).toBe(50);
  });

  it('the first report flags its reasons: R50 reported on a R115 request', async () => {
    await recordGatewayInvoiceReceipt({ ...base, feeRand: null, reported: { amountCents: 5000, currency: 'ZAR' } });
    expect(reasons()).toEqual([['amount_mismatch']]);
  });

  it('an invoice outside the ledger is a reason of its own', async () => {
    h.block = 'invoice_draft';
    await recordGatewayInvoiceReceipt({ ...base, feeRand: null, reported: { amountCents: 11500, currency: 'ZAR' } });
    expect(reasons()).toEqual([['invoice_draft']]);
  });

  it('dedupe: Paystack reporting R103 after a first report of R100 is flagged though both bank R100', async () => {
    h.already = { id: 'p-1', created_by: USER, bank_account_id: 'bank-1', payment_date: '2026-10-02',
      total_amount: '100.00', description: 'Paystack card payment r181_wiring' };
    await recordGatewayInvoiceReceipt({ ...base, requestedCents: 10000, feeRand: 3,
      reported: { amountCents: 10300, currency: 'ZAR', requestedAmountCents: 10000, feeCents: 300 } });
    expect(reasons()).toEqual([['amount_disagrees_with_first_report']]);
  });

  it('dedupe: a one-cent difference from the banked figure is flagged (R2.01 banked, R2.00 reported)', async () => {
    h.already = { id: 'p-1', created_by: USER, bank_account_id: 'bank-1', payment_date: '2026-10-02',
      total_amount: '2.01', description: 'Paystack card payment r181_wiring' };
    await recordGatewayInvoiceReceipt({ ...base, requestedCents: 200, feeRand: null, reported: { amountCents: 200, currency: 'ZAR' } });
    expect(reasons()).toEqual([['amount_disagrees_with_first_report']]);
  });

  it('dedupe: the same Paystack amount but bank figures one cent apart is flagged (R2.01 banked, R2.00 now)', async () => {
    h.already = { id: 'p-1', created_by: USER, bank_account_id: 'bank-1', payment_date: '2026-10-02',
      total_amount: '2.01', description: 'Paystack card payment r181_wiring [paystack amount 205 cents]' };
    await recordGatewayInvoiceReceipt({ ...base, requestedCents: 200, feeRand: null,
      reported: { amountCents: 205, currency: 'ZAR', requestedAmountCents: 200, feeCents: 5 } });
    expect(reasons()).toEqual([['amount_disagrees_with_first_report']]);
  });

  it('the receipt INSERT carries receiptDescription (the first report amount tag)', async () => {
    await recordGatewayInvoiceReceipt({ ...base, feeRand: 3.5,
      reported: { amountCents: 11850, currency: 'ZAR', requestedAmountCents: 11500, feeCents: 350 } });
    expect(receiptInsert()!.values[7]).toBe('Paystack card payment r181_wiring [paystack amount 11850 cents]');
  });

  it('a merge moved the invoice: the receipt is re-pointed to the customer read under the lock', async () => {
    const SURVIVOR = '55555555-5555-4555-8555-555555555555';
    h.clientId = SURVIVOR;
    await recordGatewayInvoiceReceipt({ ...base, feeRand: null, reported: { amountCents: 11500, currency: 'ZAR' } });
    const repoint = h.calls.find((c) => c.text.includes('UPDATE customer_payments SET client_id'));
    expect(repoint?.values[0]).toBe(SURVIVOR);
  });

  it('a one-cent allocation is inserted', async () => {
    h.allocated = 0.01;
    await recordGatewayInvoiceReceipt({ ...base, feeRand: null, reported: { amountCents: 11500, currency: 'ZAR' } });
    expect(allocationInsert()?.values[2]).toBe(0.01);
  });
});
