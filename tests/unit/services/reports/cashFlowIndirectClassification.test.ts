/**
 * The Reports Cash Flow screen (indirect method) listed four kinds of non-cash movement: P&L, receivables,
 * payables and fixed assets / equity. Every other balance-sheet line (VAT control, inventory, prepayments, payroll and
 * other current liabilities, accumulated depreciation, loans, retained earnings) fell through, so after a R1 150 cash
 * sale (R1 000 + R150 VAT) the screen showed Operating -7 000 / Closing 287 750 where the ledger holds 287 900.
 *
 * By double entry, cash moves by the credit-less-debit of every NON-cash line, so the statement ties to cash only
 * if EVERY non-cash account lands in exactly one line. This walks the whole subtype vocabulary to hold that.
 */
import { describe, expect, it } from 'vitest';
import { ALL_RAW_SUBTYPES, isCashEquivalent, type AccountType } from '@/modules/accounting/services/gl/accountSubtypes';
import {
  classifyIndirectLine, INDIRECT_BUCKETS, bucketSection, type IndirectBucket,
} from '@/modules/accounting/services/reports/cashFlowIndirectClassification';

const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const subtypes: Array<string | null> = [...ALL_RAW_SUBTYPES, null, '', 'default_expense', 'other', 'something_new'];

describe('every non-cash account lands in exactly one line', () => {
  for (const type of TYPES) {
    it(`${type}: each subtype (known, null, unknown) has a bucket that is a known line with a section`, () => {
      for (const subtype of subtypes) {
        if (isCashEquivalent(type, subtype)) continue; // the cash accounts themselves are the thing being explained
        const bucket = classifyIndirectLine(type, subtype);
        expect(INDIRECT_BUCKETS, `${type}/${String(subtype)}`).toContain(bucket);
        expect(['operating', 'investing', 'financing'], `${type}/${String(subtype)}`).toContain(bucketSection(bucket));
      }
    });
  }
});

describe('what the screen used to leave out', () => {
  const b = (type: AccountType, subtype: string | null): IndirectBucket => classifyIndirectLine(type, subtype);
  it('VAT control accounts (both sides, and the input-claim clearing account) are the VAT line', () => {
    expect(b('liability', 'vat_output')).toBe('vat');
    expect(b('asset', 'vat_input')).toBe('vat');
    expect(b('asset', 'vat_input_late_claim')).toBe('vat');
  });
  it('inventory, prepayments, other current assets and unclassified balance-sheet lines are operating', () => {
    expect(b('asset', 'inventory')).toBe('inventory');
    for (const s of ['prepaid_expense', 'other_current_asset', 'current_asset', null, 'something_new']) {
      expect(b('asset', s), String(s)).toBe('other_operating');
      expect(bucketSection('other_operating')).toBe('operating');
    }
    for (const s of ['payroll_liability', 'current_liability', 'other_current_liability', null, 'something_new']) {
      expect(b('liability', s), String(s)).toBe('other_operating');
    }
  });
  it('accumulated depreciation is the non-cash add-back, in operating', () => {
    expect(b('asset', 'accumulated_depreciation')).toBe('depreciation');
    expect(bucketSection('depreciation')).toBe('operating');
  });
  it('trade receivables and payables keep their own lines', () => {
    expect(b('asset', 'receivable')).toBe('receivable');
    expect(b('liability', 'payable')).toBe('payable');
  });
  it('fixed assets, intangibles and investments are investing', () => {
    for (const s of ['fixed_asset', 'fixed_assets', 'intangible_asset', 'investment', 'non_current_asset']) {
      expect(bucketSection(b('asset', s)), s).toBe('investing');
    }
  });
  it('loans, credit cards, equity and retained earnings are financing', () => {
    expect(b('liability', 'long_term_liability')).toBe('debt');
    expect(b('liability', 'non_current_liability')).toBe('debt');
    expect(b('liability', 'credit_card')).toBe('debt');
    expect(b('equity', 'equity')).toBe('equity');
    expect(b('equity', null)).toBe('equity');
    expect(b('equity', 'retained_earnings')).toBe('retained_earnings');
    for (const bucket of ['debt', 'equity', 'retained_earnings'] as const) expect(bucketSection(bucket)).toBe('financing');
  });
  it('a liability spelled bank or cash is a credit card: debt, as in the direct method', () => {
    for (const s of ['bank', 'bank_account', 'cash', 'petty_cash']) expect(b('liability', s), s).toBe('debt');
    expect(b('asset', 'bank_account')).toBe('other_operating'); // (an asset of that spelling is cash and never reaches the classifier)
  });
  it('accumulated depreciation is classified as the add-back; the service splits its releases (debits) into investing', () => {
    expect(b('asset', 'accumulated_depreciation')).toBe('depreciation');
  });
  it('revenue and expense are net income whatever their subtype', () => {
    expect(b('revenue', 'disposal_profit_loss')).toBe('net_income');
    expect(b('expense', 'default_expense')).toBe('net_income');
    expect(b('expense', 'depreciation_expense')).toBe('net_income');
  });
});
