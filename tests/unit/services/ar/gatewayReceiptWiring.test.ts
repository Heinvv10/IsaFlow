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
    allocated: hold ? 0 : Math.min(amountRand, 115), invoiceBlock: hold, overpaid: false,
    clientId: CUSTOMER, status: 'sent', deleted: false,
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

const fee = postGatewayFee as unknown as ReturnType<typeof vi.fn>;
const allocate = decideGatewayAllocation as unknown as ReturnType<typeof vi.fn>;
const receiptInsert = () => h.calls.find((c) => c.text.includes('INSERT INTO customer_payments ('));
const base = { companyId: '33333333-3333-4333-8333-333333333333', invoiceId: '44444444-4444-4444-8444-444444444444',
  reference: 'r181_wiring', requestedCents: 11500 };

beforeEach(() => { h.calls.length = 0; h.already = null; fee.mockClear(); allocate.mockClear(); });

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
});
