/**
 * Cash-flow classification for the direct-method cash flow statement.
 *
 * Kept separate from the query that feeds it so the rule is a pure function
 * over (account_type, account_subtype) and can be tested without a database.
 *
 * WHY THIS EXISTS. The classification used to live in a SQL CASE that matched
 * `account_subtype IN ('revenue','receivable')`, `('payroll')` and
 * `('expense','payable','cost_of_sales')`. Those are not the spellings real
 * charts use: production carries `default_revenue`, `sales`, `other_income`,
 * `payroll_liability`, `operating_expense`, `admin_expense`, `fixed_assets`.
 * 4,650 of 6,341 contra lines therefore fell through to the `other_operating`
 * catch-all and 73% of a "direct" cash flow statement was one undifferentiated
 * line. Everything here goes through `canonicalSubtype`, which owns the
 * spelling vocabulary, so a new importer spelling is added in one place.
 */

import {
  canonicalSubtype,
  isCashEquivalent,
  type AccountType,
} from '@/modules/accounting/services/gl/accountSubtypes';

export type CashGroup =
  | 'cash_received_from_customers'
  | 'cash_paid_to_suppliers'
  | 'cash_paid_to_employees'
  | 'other_operating'
  | 'investing'
  | 'financing';

export const OPERATING_GROUPS: ReadonlySet<CashGroup> = new Set<CashGroup>([
  'cash_received_from_customers',
  'cash_paid_to_suppliers',
  'cash_paid_to_employees',
  'other_operating',
]);

/**
 * Which cash-flow activity a bank movement belongs to, judged by the account
 * on the other side of the entry.
 *
 * Unrecognised and NULL subtypes resolve to `other_operating` rather than
 * being dropped: a line that cannot be classified is still cash that moved,
 * and dropping it would break the tie-out to the bank balance. Operating is
 * the conservative bucket — misclassifying within operating does not change
 * the operating/investing/financing split that readers rely on.
 */
export function classifyCashGroup(
  accountType: AccountType,
  subtype: string | null | undefined,
): CashGroup {
  // Equity movements are financing regardless of how the subtype is spelled —
  // share issues, buybacks and distributions all land here.
  if (accountType === 'equity') return 'financing';

  const canon = canonicalSubtype(subtype);

  switch (canon) {
    case 'receivable':
    case 'revenue':
    case 'sales':
    case 'other_income':
      return 'cash_received_from_customers';

    case 'payroll_liability':
      return 'cash_paid_to_employees';

    case 'payable':
    case 'cost_of_sales':
    case 'operating_expense':
    case 'admin_expense':
    case 'insurance_expense':
    case 'other_expense':
    case 'prepaid_expense':
    case 'inventory':
      return 'cash_paid_to_suppliers';

    case 'fixed_asset':
    case 'non_current_asset':
    case 'intangible_asset':
    case 'investment':
    case 'accumulated_depreciation':
      return 'investing';

    case 'long_term_liability':
    case 'non_current_liability':
    case 'credit_card':
    case 'equity':
    case 'retained_earnings':
    case 'opening_balance_equity':
      return 'financing';

    // Taxation and interest are presented within operating activities, which
    // IAS 7.33-35 permits and is the norm for SA owner-managed entities.
    // Everything else — VAT control, current assets and liabilities, and any
    // subtype `canonicalSubtype` does not recognise — is operating too.
    default:
      return 'other_operating';
  }
}

/** A journal line on the other side of a bank movement. */
export interface ContraLine {
  accountType: AccountType;
  accountSubtype: string | null;
  /** Signed `debit - credit` for this line. */
  amount: number;
}

export interface CashAllocation {
  cashGroup: CashGroup;
  amount: number;
}

/**
 * Split one bank leg across the contra lines of its journal entry.
 *
 * THE BANK LEG IS DISTRIBUTED EXACTLY ONCE. That is the whole point: the
 * previous implementation joined the bank leg to every contra line and summed
 * the BANK amount per contra, so a two-line entry counted the bank movement
 * twice. On production that reported net cash of -R9,089,506.51 against a true
 * bank movement of +R381,207.22.
 *
 * Cash-equivalent contras are excluded first — a transfer between two bank
 * accounts is not a cash flow, and both its legs are handled independently.
 * The remaining contras take a share proportional to their own magnitude. In a
 * balanced single-bank-leg entry that share works out to exactly the negated
 * contra amount; the proportional form is what keeps the total exact when an
 * entry carries more than one bank leg.
 *
 * When there is no classifiable contra at all (a pure bank-to-bank transfer),
 * the whole leg goes to `other_operating`. Its opposite leg carries the
 * opposite sign, so the pair nets to zero and the tie-out still holds.
 */
export function apportionBankLeg(
  bankAmount: number,
  contras: readonly ContraLine[],
): CashAllocation[] {
  const classifiable = contras.filter(
    (c) => !isCashEquivalent(c.accountType, c.accountSubtype),
  );

  const totalWeight = classifiable.reduce((s, c) => s + Math.abs(c.amount), 0);

  if (classifiable.length === 0 || totalWeight === 0) {
    return [{ cashGroup: 'other_operating', amount: bankAmount }];
  }

  return classifiable.map((c) => ({
    cashGroup: classifyCashGroup(c.accountType, c.accountSubtype),
    amount: bankAmount * (Math.abs(c.amount) / totalWeight),
  }));
}
