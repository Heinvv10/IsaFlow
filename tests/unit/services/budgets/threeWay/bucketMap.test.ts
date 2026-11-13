/**
 * P6 PR C (spec §5 Buckets, §13 items 6 and 10): which balance-sheet bucket an
 * account's opening balance lands in, and which engine P&L band a budget line
 * feeds. Pure.
 */
import { describe, expect, it } from 'vitest';
import { bucketOf, payableSlotAllowed, pnlBandOf } from '@/modules/accounting/services/budgets/threeWay/bucketMap';

const plain = { isLoanAccount: false, isRetainedEarningsAccount: false };

describe('bucketOf: canonical subtype → bucket (§13.10)', () => {
  it.each([
    ['asset', 'bank', 'cash'],
    ['asset', 'Bank Account', 'cash'],
    ['asset', 'petty_cash', 'cash'],
    ['asset', 'receivable', 'receivables'],
    ['asset', 'Debtors', 'receivables'],
    ['asset', 'stock', 'inventory'],
    ['asset', 'vat_input', 'vatControl'],
    ['liability', 'vat_output', 'vatControl'],
    ['asset', 'fixed_assets', 'fixedAssets'],
    ['asset', 'accumulated_depreciation', 'accumDepreciation'],
    ['asset', 'prepayments', 'otherCurrentAssets'],
    ['asset', 'current_asset', 'otherCurrentAssets'],
    ['asset', 'intangible_asset', 'otherNonCurrentAssets'],
    ['asset', 'investment', 'otherNonCurrentAssets'],
    ['asset', 'non_current_asset', 'otherNonCurrentAssets'],
    ['liability', 'creditors', 'payables'],
    ['liability', 'payroll_liability', 'payrollLiabilities'],
    ['liability', 'long_term_liability', 'loans'],
    ['liability', 'non_current_liabilities', 'loans'],
    ['liability', 'credit_card', 'otherCurrentLiabilities'],
    ['liability', 'current_liability', 'otherCurrentLiabilities'],
    ['equity', 'share_capital', 'shareCapital'],
    ['equity', 'equity', 'shareCapital'],
    ['equity', 'retained_earnings', 'retainedEarnings'],
    ['equity', 'dividends', 'retainedEarnings'],
    ['equity', 'opening_balance_equity', 'otherEquity'],
  ] as const)('%s %s → %s (mapped)', (type, subtype, bucket) => {
    expect(bucketOf(type, subtype, plain)).toEqual({ bucket, mapped: true });
  });

  it('vat_input_late_claim is NOT VAT control and eti_refund_receivable is NOT receivables (§13.10)', () => {
    expect(bucketOf('asset', 'vat_input_late_claim', plain)).toEqual({ bucket: 'otherCurrentAssets', mapped: true });
    expect(bucketOf('asset', 'eti_refund_receivable', plain)).toEqual({ bucket: 'otherCurrentAssets', mapped: true });
  });

  it('a liability spelled bank/cash is a credit card: otherCurrentLiabilities, never cash (§13.10)', () => {
    expect(bucketOf('liability', 'bank', plain)).toEqual({ bucket: 'otherCurrentLiabilities', mapped: true });
    expect(bucketOf('liability', 'bank_account', plain)).toEqual({ bucket: 'otherCurrentLiabilities', mapped: true });
    expect(bucketOf('liability', 'cash', plain)).toEqual({ bucket: 'otherCurrentLiabilities', mapped: true });
  });

  it('an unknown or missing subtype is unmapped, current by default, per side', () => {
    expect(bucketOf('asset', null, plain)).toEqual({ bucket: 'otherCurrentAssets', mapped: false });
    expect(bucketOf('asset', 'other', plain)).toEqual({ bucket: 'otherCurrentAssets', mapped: false });
    expect(bucketOf('liability', null, plain)).toEqual({ bucket: 'otherCurrentLiabilities', mapped: false });
    expect(bucketOf('equity', null, plain)).toEqual({ bucket: 'otherEquity', mapped: false });
  });

  it('a subtype of the other side does not claim the account (an asset spelled payable is unmapped)', () => {
    expect(bucketOf('asset', 'payable', plain)).toEqual({ bucket: 'otherCurrentAssets', mapped: false });
    expect(bucketOf('liability', 'receivable', plain)).toEqual({ bucket: 'otherCurrentLiabilities', mapped: false });
    expect(bucketOf('liability', 'fixed_asset', plain)).toEqual({ bucket: 'otherCurrentLiabilities', mapped: false });
  });

  it("a loan's GL or current-portion account is a loan whatever its subtype (§13.10)", () => {
    const loan = { isLoanAccount: true, isRetainedEarningsAccount: false };
    expect(bucketOf('liability', null, loan)).toEqual({ bucket: 'loans', mapped: true });
    expect(bucketOf('liability', 'current_liability', loan)).toEqual({ bucket: 'loans', mapped: true });
  });

  it("the system retained-earnings account is retained earnings whatever its subtype (§13.8: derived RE joins it)", () => {
    const re = { isLoanAccount: false, isRetainedEarningsAccount: true };
    expect(bucketOf('equity', 'equity', re)).toEqual({ bucket: 'retainedEarnings', mapped: true });
    expect(bucketOf('equity', null, re)).toEqual({ bucket: 'retainedEarnings', mapped: true });
  });

  it('a revenue or expense account has no bucket', () => {
    expect(() => bucketOf('revenue' as never, 'sales', plain)).toThrow(RangeError);
  });
});

describe('pnlBandOf: budget line → engine band (§13.6)', () => {
  it.each([
    ['revenue', 'sales', 'turnover'],
    ['revenue', 'revenue', 'turnover'],
    ['revenue', null, 'turnover'],
    ['revenue', 'other_income', 'otherIncome'],
    ['revenue', 'other_revenue', 'otherIncome'],
    ['expense', 'cost_of_sales', 'costOfSales'],
    ['expense', 'COGS', 'costOfSales'],
    ['expense', 'salaries', 'payroll'],
    ['expense', 'payroll_expense', 'payroll'],
    ['expense', 'depreciation', 'depreciation'],
    ['expense', 'finance_cost', 'financeCost'],
    ['expense', 'tax_expense', 'taxExpense'],
    ['expense', 'operating_expense', 'otherOpex'],
    ['expense', 'insurance_expense', 'otherOpex'],
    ['expense', 'other_expense', 'otherOpex'],
    ['expense', null, 'otherOpex'],
  ] as const)('%s %s → %s', (type, subtype, band) => {
    expect(pnlBandOf(type, subtype)).toBe(band);
  });
});

describe('payableSlotAllowed (review R1)', () => {
  it.each([null, 'current_liability', 'other_current_liabilities', 'other'])('%s: allowed (other current liabilities)', (sub) => {
    expect(payableSlotAllowed(sub, false)).toBe(true);
  });
  it.each(['payable', 'vat_output', 'vat_input', 'payroll_liability', 'long_term_liability', 'non_current_liability', 'credit_card', 'bank', 'cash'])(
    '%s: refused', (sub) => { expect(payableSlotAllowed(sub, false)).toBe(false); });
  it("a loan's account is refused whatever its subtype", () => {
    expect(payableSlotAllowed(null, true)).toBe(false);
  });
});
