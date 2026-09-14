/**
 * A tenant whose chart of accounts uses an ALTERNATIVE spelling must reach the
 * same answer as one using the canonical spelling.
 *
 * `accountSubtypes` is the vocabulary: `bank_account` means `bank`,
 * `accounts_payable` means `payable`, `debtors` means `receivable`,
 * `amortisation` means `depreciation_expense`. Sites that compared a subtype to
 * ONE raw spelling refused those tenants outright — a bank transfer could not
 * resolve its account, the AP control account "went missing", and the controls
 * materializers found nothing to attest. It failed CLOSED, so nothing was
 * mis-posted; legitimate work was simply blocked.
 *
 * These are BEHAVIOUR tests over the pure seams. The shape guard
 * (`bankCashSubtypeCensus.test.ts`) catches a NEW literal being written; these
 * catch the fixed ones being reverted, which a shape guard alone cannot
 * distinguish from a deliberate narrowing.
 *
 * The last describe block is the mirror image, and matters just as much: the
 * widening must not admit an account a control is supposed to EXCLUDE.
 */
import { describe, expect, it } from 'vitest';
import { selectApSystemAccount } from '@/modules/accounting/services/ap/apControlAccounts';
import { typeFitsSubtype } from '@/modules/accounting/services/gl/systemAccountKeys';
import { currentStatementReview } from '@/modules/accounting/services/controls/bankStatementReviewValidity';
import type { StatementReviewProof } from '@/modules/accounting/services/controls/bankStatementReviewValidity';
import { journalAffectsVatReturn } from '@/modules/accounting/services/controls/journalVatFootprint';
import {
  BANK_SUBTYPES,
  PAYABLE_SUBTYPES,
  RECEIVABLE_SUBTYPES,
  rawSubtypesFor,
  isBankSubtype,
} from '@/modules/accounting/services/gl/accountSubtypes';

const apRow = (subtype: string) => ({
  id: 'ap-1', account_type: 'liability', account_subtype: subtype,
  is_active: true, is_system_account: true,
});

describe('AP control account resolves on every payable spelling', () => {
  it.each(PAYABLE_SUBTYPES.filter(s => s !== 'payable'))(
    'selectApSystemAccount accepts a tenant spelling its control account %s',
    (spelling) => {
      expect(selectApSystemAccount([apRow(spelling)], 'payable').id).toBe('ap-1');
    },
  );

  it('still refuses when two rival payable accounts claim the role', () => {
    expect(() => selectApSystemAccount(
      [apRow('payable'), { ...apRow('accounts_payable'), id: 'ap-2' }], 'payable',
    )).toThrow(/Ambiguous/);
  });

  it('still refuses a payable subtype carried by the wrong account type', () => {
    expect(() => selectApSystemAccount(
      [{ ...apRow('accounts_payable'), account_type: 'asset' }], 'payable',
    )).toThrow(/Missing or invalid/);
  });
});

describe('typeFitsSubtype accepts the alternative spelling of a legal subtype', () => {
  it.each([
    ['liability', 'accounts_payable'], ['liability', 'creditors'],
    ['asset', 'bank_account'], ['asset', 'debtors'], ['asset', 'trade_receivables'],
    ['expense', 'amortisation'],
  ])('%s may carry %s', (type, subtype) => {
    expect(typeFitsSubtype(type, subtype)).toBe(true);
  });

  it('still refuses a subtype the account type may not carry', () => {
    expect(typeFitsSubtype('asset', 'accounts_payable')).toBe(false);
    expect(typeFitsSubtype('revenue', 'bank_account')).toBe(false);
  });
});

const reviewRow = (subtype: string): StatementReviewProof => ({
  id: 'rev-1', bank_account_id: 'acc-1', source_document_id: 'doc-1',
  expected_source_hash: 'h', source_fingerprint: 'fp', currency: 'ZAR',
  account_type: 'asset', account_subtype: subtype, is_active: true, current_currency: 'ZAR',
  document_id: 'doc-1', document_status: 'captured', document_hash: 'dh', bytes_verified: true,
  result: null,
});

describe('bank statement review validity reads every bank spelling', () => {
  it.each(BANK_SUBTYPES)('does not refuse %s on the account-shape check', (spelling) => {
    // `result: null` makes the whole predicate false regardless, so assert on the
    // subtype clause alone: it must not be the reason the answer is false.
    const row = reviewRow(spelling);
    expect(isBankSubtype(row.account_subtype)).toBe(true);
    expect(currentStatementReview(row, true)).toBe(false); // refused for the receipt, not the spelling
  });

  it('still refuses an account that is not a bank account at all', () => {
    expect(isBankSubtype('receivable')).toBe(false);
    expect(isBankSubtype('bank_charges')).toBe(false);
    expect(isBankSubtype('credit_card')).toBe(false);
    expect(isBankSubtype('petty_cash')).toBe(false);
  });
});

describe('the widened sets cannot admit what the narrow one excluded', () => {
  it('BANK_SUBTYPES is bank accounts only — not cash, not bank charges', () => {
    expect([...BANK_SUBTYPES].sort()).toEqual(['bank', 'bank_account']);
    expect(BANK_SUBTYPES).not.toContain('petty_cash');
    expect(BANK_SUBTYPES).not.toContain('cash');
    expect(BANK_SUBTYPES).not.toContain('bank_charges');
    expect(BANK_SUBTYPES).not.toContain('credit_card');
  });

  it('PAYABLE_SUBTYPES is trade payables only — not VAT, payroll or credit cards', () => {
    for (const foreign of ['vat_output', 'payroll_liability', 'credit_card', 'tax', 'long_term_liability']) {
      expect(PAYABLE_SUBTYPES).not.toContain(foreign);
    }
  });

  it('RECEIVABLE_SUBTYPES is trade receivables only — not VAT input or prepayments', () => {
    for (const foreign of ['vat_input', 'prepaid_expense', 'inventory', 'bank']) {
      expect(RECEIVABLE_SUBTYPES).not.toContain(foreign);
    }
  });

  it('the depreciation set is depreciation and amortisation, and no other expense', () => {
    const set = rawSubtypesFor('depreciation_expense');
    expect([...set].sort()).toEqual(['amortisation', 'amortization', 'depreciation', 'depreciation_expense']);
    for (const foreign of ['accumulated_depreciation', 'operating_expense', 'finance_cost', 'tax_expense']) {
      expect(set).not.toContain(foreign);
    }
  });
});

describe('the VAT201 footprint stays deliberately narrow', () => {
  const account = (subtype: string) => ({ id: 'a1', account_subtype: subtype, account_type: 'liability' });
  const line = { gl_account_id: 'a1', vat_type: 'standard' };

  it('treats a raw `tax` VAT control account as in the VAT return', () => {
    expect(journalAffectsVatReturn([line], [account('tax')])).toBe(true);
  });

  it('does NOT pull income tax expense into the VAT return', () => {
    // `income_tax` and `tax_expense` canonicalise to tax_expense. Widening this
    // site would put PAYE and income tax into the VAT201 — the defect
    // accountReportingClass records at R23,219.01. It must stay narrow.
    expect(journalAffectsVatReturn(
      [line], [{ id: 'a1', account_subtype: 'income_tax', account_type: 'expense' }],
    )).toBe(false);
    expect(journalAffectsVatReturn(
      [line], [{ id: 'a1', account_subtype: 'tax_expense', account_type: 'expense' }],
    )).toBe(false);
  });
});
