/**
 * A RATIO'S INPUT IS A LINE OF THE INCOME STATEMENT, NOT A SECOND CLASSIFICATION.
 *
 * The ledger ratio read summed journal lines by hand-listed subtypes and no
 * account type:
 *  - "interest expense" was the whole finance-cost band, which the vocabulary
 *    aliases `bank_charges` into — a debt-free company with bank fees printed
 *    an interest cover of hundreds;
 *  - `raw_materials` is an inventory ASSET subtype, so "direct material cost"
 *    was stock movement;
 *  - `uif`, `medical_aid` and friends are not in the vocabulary, so they were
 *    employee cost here and unclassified operating expenses on the statement.
 *
 * `ledgerRatioLines` folds the same `account_type, account_subtype` rows the
 * statement's classifier folds, through that classifier.
 */
import { describe, expect, it } from 'vitest';
import { aggregateFigures, expenseBand, type ClassificationRow } from '@/modules/accounting/services/gl/accountClassification';
import { ledgerRatioLines } from '@/modules/accounting/services/reports/ledgerRatioLines';

const row = (account_type: ClassificationRow['account_type'], account_subtype: string | null, debit: number, credit = 0): ClassificationRow =>
  ({ account_type, account_subtype, debit, credit });

describe('interest expense', () => {
  it('is nil for a company with bank charges and no borrowings', () => {
    expect(ledgerRatioLines([row('expense', 'bank_charges', 4_200)]).interestExpense).toBe(0);
  });

  it('is the interest account\'s charge', () => {
    expect(ledgerRatioLines([row('expense', 'interest_expense', 31_250.75)]).interestExpense).toBe(31_250.75);
  });

  it('leaves the bank charges out where a chart has both', () => {
    const lines = ledgerRatioLines([row('expense', 'interest_expense', 31_250.75), row('expense', 'bank_charges', 4_200)]);
    expect(lines.interestExpense).toBe(31_250.75);
  });

  // The seeded chart's one finance-cost account is named "Interest Expense"
  // and carries the generic subtype; its bank charges are an operating
  // expense. Finance cost that is not bank charges is the cost of borrowing.
  it.each(['finance_cost', 'finance_costs', 'Finance Cost'])('counts the generic %s subtype as the cost of borrowing', (subtype) => {
    expect(ledgerRatioLines([row('expense', subtype, 9_000)]).interestExpense).toBe(9_000);
  });

  it('is net of a credit to the account', () => {
    expect(ledgerRatioLines([row('expense', 'interest_expense', 1_000, 1_600)]).interestExpense).toBe(-600);
  });
});

describe('the account type comes first', () => {
  it('reads no interest, tax or employee cost off a balance-sheet account that carries the subtype', () => {
    const lines = ledgerRatioLines([
      row('liability', 'tax', 0, 80_000),           // a VAT control account
      row('asset', 'interest_expense', 5_000),
      row('liability', 'salaries', 0, 60_000),      // net salaries payable
      row('asset', 'interest_income', 7_000),
      row('expense', 'interest_income', 3_000),
    ]);
    expect(lines).toEqual({ interestExpense: 0, interestIncome: 0, employeeCosts: 0, taxExpense: 0 });
  });

  it('reads interest income off a revenue account, credit less debit', () => {
    expect(ledgerRatioLines([row('revenue', 'interest_income', 100, 4_200.1)]).interestIncome).toBe(4_100.1);
  });

  it('has no direct-materials line: raw materials are stock, an asset', () => {
    const lines = ledgerRatioLines([row('asset', 'raw_materials', 120_000), row('expense', 'raw_materials', 50_000)]);
    expect(lines).not.toHaveProperty('directMaterialCosts');
  });
});

describe('employee cost', () => {
  it('is the payroll band of the vocabulary, in every spelling', () => {
    const lines = ledgerRatioLines([row('expense', 'salaries', 200_000), row('expense', 'wages', 10_500.35), row('expense', 'employee_benefits', 1_000)]);
    expect(lines.employeeCosts).toBe(211_500.35);
  });

  it.each(['uif', 'medical_aid', 'provident_fund', 'leave_pay', 'bonuses'])('does not include %s, which the statement reports as an unclassified operating expense', (subtype) => {
    expect(ledgerRatioLines([row('expense', subtype, 12_000)]).employeeCosts).toBe(0);
  });
});

/** A ledger with something in every band, and the traps above. */
const BOOK: ClassificationRow[] = [
  row('revenue', 'sales', 0, 900_000.4), row('revenue', 'interest_income', 0, 4_100.1), row('revenue', 'other_income', 0, 2_000),
  row('expense', 'cost_of_sales', 300_000), row('expense', 'operating_expense', 150_000),
  row('expense', 'salaries', 210_500.35), row('expense', 'uif', 2_105),
  row('expense', 'interest_expense', 31_250.75), row('expense', 'finance_cost', 1_000), row('expense', 'bank_charges', 4_200.5),
  row('expense', 'income_tax', 48_600.2), row('expense', 'deferred_tax_expense', 1_399.8), row('expense', 'other_expense', 700),
  row('asset', 'raw_materials', 120_000), row('liability', 'tax', 0, 80_000), row('asset', 'bank', 500_000),
];

describe('against the income statement the classifier produces from the same rows', () => {
  const statement = aggregateFigures(BOOK);
  const lines = ledgerRatioLines(BOOK);
  const bandTotal = (pick: (r: ClassificationRow) => boolean) =>
    BOOK.filter((r) => r.account_type === 'expense' && pick(r)).reduce((t, r) => t + Number(r.debit) - Number(r.credit), 0);

  it('interest, bank charges, tax and other expenses are the statement\'s other-expense line', () => {
    const bankCharges = 4_200.5;
    const other = 700;
    expect(lines.interestExpense + bankCharges + lines.taxExpense + other).toBeCloseTo(statement.otherExpenses, 2);
  });

  it('every account read as interest or tax is one the statement reports below the operating line', () => {
    expect(lines.interestExpense + lines.taxExpense).toBeCloseTo(
      bandTotal((r) => expenseBand(r.account_subtype) === 'other_expense') - 4_200.5 - 700, 2);
  });

  it('tax is current and deferred together', () => {
    expect(lines.taxExpense).toBe(50_000);
  });

  it('employee cost is inside the statement\'s operating expenses, and is the payroll accounts alone', () => {
    expect(lines.employeeCosts).toBe(210_500.35);
    expect(statement.operatingExpenses).toBeCloseTo(150_000 + 210_500.35 + 2_105, 2);
  });

  it('profit before tax is the statement\'s: net profit with the tax put back', () => {
    const beforeTax = statement.operatingProfit - (statement.otherExpenses - lines.taxExpense);
    expect(statement.netProfit + lines.taxExpense).toBeCloseTo(beforeTax, 2);
  });
});
