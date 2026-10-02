/**
 * R-181: the Paystack settlement money rules, as pure functions, so CI runs them (the integration
 * suites need a database and are skipped on GitHub). Every case in
 * docs/audits/remediation/R-181/fix.md is pinned here: what is banked and why it is flagged
 * (`settledCharge`), the fee leg (`merchantFee`) with Bank netting to `amount - fees` wherever it
 * can, the review note, the receipt description's amount tag, and the invoice allocation.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));

import {
  composeReviewNote,
  firstReportedAmountCents,
  invoiceReview,
  merchantFee,
  receiptDescription,
  settledCharge,
  type ReportedCharge,
} from '@/modules/accounting/services/ar/gatewaySettlementReview';
import { allocationPlan } from '@/modules/accounting/services/ar/gatewayReceiptAllocation';

const zar = (amountCents: unknown, extra: Partial<ReportedCharge> = {}): ReportedCharge =>
  ({ amountCents, currency: 'ZAR', ...extra });

describe('settledCharge: what is banked, and why it is flagged', () => {
  it.each([
    ['reported = requested', 11500, zar(11500), 11500, []],
    ['reported < requested', 11500, zar(5000), 5000, ['amount_mismatch']],
    ['reported > requested', 11500, zar(20000), 20000, ['amount_mismatch']],
    ['currency USD', 11500, { amountCents: 11500, currency: 'USD' }, 11500, ['currency_mismatch']],
    ['no amount', 11500, zar(undefined), 11500, ['amount_not_reported']],
    ['amount 0', 11500, zar(0), 11500, ['amount_not_reported']],
    ['fractional cents', 11500, zar(115.5), 11500, ['amount_not_reported']],
    ['pass-on fee within fees: requested_amount', 11500, zar(11850, { requestedAmountCents: 11500, feeCents: 350 }), 11500, []],
    ['merchant bears the fee', 11500, zar(11500, { requestedAmountCents: 11500, feeCents: 350 }), 11500, []],
    ['requested_amount differs from the request', 11500, zar(5150, { requestedAmountCents: 5000, feeCents: 150 }), 5000, ['amount_mismatch']],
    ['amount below requested_amount', 11500, zar(11000, { requestedAmountCents: 11500 }), 11000,
      ['amount_mismatch', 'amount_below_requested_amount']],
    ['excess above fees (R103 / R50 / R3)', 10000, zar(10300, { requestedAmountCents: 5000, feeCents: 300 }), 10300,
      ['amount_mismatch', 'requested_amount_exceeds_fee']],
    ['excess above fees (R103 / R100 / R2)', 10000, zar(10300, { requestedAmountCents: 10000, feeCents: 200 }), 10300,
      ['amount_mismatch', 'requested_amount_exceeds_fee']],
    ['excess equal to fees is trusted (R103 / R100 / R3)', 10000, zar(10300, { requestedAmountCents: 10000, feeCents: 300 }), 10000, []],
    ['LOW-1 accepted: one cent above fees (10301 / 10000 / 300)', 10000, zar(10301, { requestedAmountCents: 10000, feeCents: 300 }), 10301,
      ['amount_mismatch', 'requested_amount_exceeds_fee']],
    ['no fee figure: amount, unverified', 11500, zar(11850, { requestedAmountCents: 11500, feeCents: null }), 11850,
      ['amount_mismatch', 'requested_amount_unverified']],
    ['requested_amount = amount needs no fee figure', 11500, zar(11500, { requestedAmountCents: 11500, feeCents: null }), 11500, []],
    ['requested_amount with no amount', 11500, zar(undefined, { requestedAmountCents: 11500, feeCents: 350 }), 11500, ['amount_not_reported']],
  ] as const)('%s', (_label, requestedCents, reported, cents, reviews) => {
    expect(settledCharge(requestedCents, reported)).toEqual({ cents, reviews });
  });
});

describe('merchantFee: the fee leg, and Bank netting to amount - fees', () => {
  it.each([
    // label, fee (rand), reported, banked cents, posted fee, reviews, Paystack's deposit (cents) or null when unreachable
    ['no fee', null, zar(11500), 11500, null, [], null],
    ['merchant bears the fee', 3.5, zar(11500), 11500, 3.5, [], 11150],
    ['pass-on: the customer paid it', 3.5, zar(11850), 11500, 0, [], 11500],
    ['verify banked amount, then the webhook fee', 3.5, zar(11850), 11850, 3.5, [], 11500],
    ['excess above fees (R103, R3)', 3, zar(10300), 10300, 3, [], 10000],
    ['excess above fees (R103, R2)', 2, zar(10300), 10300, 2, [], 10100],
    ['LOW-1: one cent above fees', 3, zar(10301), 10301, 3, [], 10001],
    ['amount missing', 3.5, zar(undefined), 11500, 3.5, [], null],
    ['non-ZAR: not posted', 3.5, { amountCents: 11500, currency: 'USD' }, 11500, null, ['fee_not_posted_currency'], null],
    ['second report below what was banked: capped at fees', 1.5, zar(5000), 6000, 1.5, ['fee_clamped'], null],
    ['second report above what was banked by more than fees', 3, zar(10500), 10000, 0, ['fee_clamped'], null],
    ['fee larger than the receipt: capped at the receipt', 200, zar(10000), 10000, 100, ['fee_exceeds_receipt'], null],
  ] as const)('%s', (_label, feeRand, reported, bankedCents, posted, reviews, deposit) => {
    const leg = merchantFee(feeRand, reported, bankedCents);
    expect(leg).toEqual({ feeRand: posted, reviews });
    if (deposit !== null) expect(Math.round(bankedCents - (leg.feeRand ?? 0) * 100)).toBe(deposit);
  });
});

describe('composeReviewNote', () => {
  it.each([
    [null, ['amount_mismatch'], 'review:amount_mismatch'],
    ['', ['amount_mismatch'], 'review:amount_mismatch'],
    ['abandoned while starting', ['amount_mismatch'], 'review:amount_mismatch | previously: abandoned while starting'],
    ['review:currency_mismatch', ['amount_mismatch'], 'review:currency_mismatch,amount_mismatch'],
    ['review:currency_mismatch | previously: x', ['amount_mismatch', 'currency_mismatch'],
      'review:currency_mismatch,amount_mismatch | previously: x'],
  ] as const)('%j + %j', (previous, reviews, note) => {
    expect(composeReviewNote(previous, [...reviews])).toBe(note);
  });
});

describe('receipt description and the first report amount', () => {
  it('names a non-ZAR currency, tags an amount that differs from the receipt, and reads it back', () => {
    expect(receiptDescription('ref1', zar(11500), 11500)).toBe('Paystack card payment ref1');
    expect(receiptDescription('ref1', { amountCents: 11500, currency: 'USD' }, 11500))
      .toBe('Paystack card payment ref1 (USD 115.00 reported, booked as ZAR)');
    const tagged = receiptDescription('ref1', zar(10300), 10000);
    expect(tagged).toBe('Paystack card payment ref1 [paystack amount 10300 cents]');
    expect(firstReportedAmountCents(tagged, 10000)).toBe(10300);
    expect(firstReportedAmountCents('Paystack card payment ref1', 10000)).toBe(10000);
    expect(firstReportedAmountCents(null, 10000)).toBe(10000);
  });
});

describe('invoiceReview', () => {
  it.each([
    ['draft', null, 'invoice_draft'],
    ['pending_approval', null, 'invoice_pending_approval'],
    ['cancelled', null, 'invoice_cancelled'],
    ['sent', '2026-10-02', 'invoice_deleted'],
    ['sent', null, null],
    ['paid', null, null],
    [null, null, null],
  ] as const)('%s (deleted %s)', (status, deletedAt, block) => {
    expect(invoiceReview(status, deletedAt)).toBe(block);
  });
});

describe('allocationPlan: what the invoice takes', () => {
  const base = { totalAmount: '115', amountPaid: '0', pending: 0, amountRand: 115, status: 'sent', deletedAt: null, hold: null };
  it.each([
    ['the balance', {}, { allocated: 115, invoiceBlock: null, overpaid: false }],
    ['a part-payment', { amountRand: 50 }, { allocated: 50, invoiceBlock: null, overpaid: false }],
    ['an overpayment', { amountRand: 200 }, { allocated: 115, invoiceBlock: null, overpaid: true }],
    ['an invoice already paid', { amountPaid: '115', status: 'paid' }, { allocated: 0, invoiceBlock: null, overpaid: true }],
    ['draft receipts already claim part', { pending: 100 }, { allocated: 15, invoiceBlock: null, overpaid: true }],
    ['a draft invoice', { status: 'draft' }, { allocated: 0, invoiceBlock: 'invoice_draft', overpaid: false }],
    ['a soft-deleted invoice', { deletedAt: '2026-10-02' }, { allocated: 0, invoiceBlock: 'invoice_deleted', overpaid: false }],
    ['a held (non-ZAR) receipt', { hold: 'unapplied_currency' }, { allocated: 0, invoiceBlock: 'unapplied_currency', overpaid: false }],
    ['a NaN total', { totalAmount: 'NaN' }, { allocated: 0, invoiceBlock: 'invoice_balance_invalid', overpaid: false }],
    ['a NaN amount_paid', { amountPaid: 'NaN' }, { allocated: 0, invoiceBlock: 'invoice_balance_invalid', overpaid: false }],
  ] as const)('%s', (_label, change, plan) => {
    expect(allocationPlan({ ...base, ...change })).toEqual(plan);
  });
});
