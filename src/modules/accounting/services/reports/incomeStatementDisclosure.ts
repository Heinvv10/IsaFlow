/**
 * The income statement's own "unclassified subtype" disclosure.
 *
 * WHY THIS REPORT SPECIFICALLY. `fetchIncomeStatementRows` bands an expense
 * whose subtype `canonicalSubtype` does not recognise into OPERATING EXPENSES —
 * the `else` beside the `=== 'cost_of_sales'` test — and says nothing about it.
 * That is how Velocity Fibre's income statement reported a 96.6% gross margin
 * on fibre construction against a real -1.9%: R82.7m of direct cost sitting
 * below the gross profit line (finding B61). The number is wrong on the one
 * screen where a person reads it.
 *
 * `unclassifiedWarning` in `../gl/financialFiguresService.ts` already computes
 * this for the ratio, waterfall, KPI and report-pack surfaces. The income
 * statement is not one of them, because it does not go through
 * `aggregateFigures` — it aggregates its own rows over its own period. So this
 * disclosure is built from THOSE rows: same query, same period bound, same
 * `canonicalSubtype` call the banding used. It cannot disagree with the figure
 * it sits under, and no flow/stock or date-range mismatch is possible.
 *
 * AN UPPER BOUND, NOT A CORRECTION. We do not know which unclassified expense
 * accounts are cost of sales — only that any that is, is currently reported
 * below gross profit. So the disclosure says gross profit is overstated by AT
 * MOST that amount. Asserting a corrected gross profit would be inventing one,
 * and the remedy is a person setting `account_subtype` per account.
 */

import { canonicalSubtype } from '../gl/accountClassification';

/** One income statement row, already signed the way the report signs it. */
export interface DisclosureInputRow {
  accountCode: string;
  accountName: string;
  accountType: 'revenue' | 'expense';
  accountSubtype: string | null;
  /** Report-signed amount: credit-debit for revenue, debit-credit for expense. */
  amount: number;
}

export interface DisclosureAccount {
  accountCode: string;
  accountName: string;
  accountType: 'revenue' | 'expense';
  amount: number;
}

export interface IncomeStatementSubtypeDisclosure {
  /** Expense accounts shown in operating expenses only because nothing said otherwise. */
  expenseAccounts: number;
  expenseAmount: number;
  /** Revenue accounts shown as turnover only because nothing said otherwise. */
  revenueAccounts: number;
  revenueAmount: number;
  /** The MOST gross profit above could be overstated by. Never a correction. */
  grossProfitOverstatedByAtMost: number;
  /** Largest offenders, biggest first. */
  accounts: DisclosureAccount[];
  /** How many affected accounts are not in `accounts`. */
  unnamedAccounts: number;
  message: string;
}

/** Below a tenth of a cent is not worth a banner. */
const MATERIAL = 0.001;

/** How many accounts to name before summarising the rest. */
const NAMED_LIMIT = 5;

const rand = (v: number): string => {
  const [whole = '0', cents = '00'] = Math.abs(v).toFixed(2).split('.');
  return `${v < 0 ? '-' : ''}R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
};

/**
 * Build the disclosure, or null when there is nothing to say.
 *
 * Null rather than a zeroed object, matching `unclassifiedWarning`'s contract:
 * a caller that forgets to check gets nothing rendered rather than a banner
 * announcing that no accounts are affected.
 */
export function buildIncomeStatementSubtypeDisclosure(
  rows: readonly DisclosureInputRow[],
): IncomeStatementSubtypeDisclosure | null {
  const affected = rows
    .filter(r => canonicalSubtype(r.accountSubtype) === null && Math.abs(r.amount) >= MATERIAL)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  if (affected.length === 0) return null;

  const expenses = affected.filter(r => r.accountType === 'expense');
  const revenues = affected.filter(r => r.accountType === 'revenue');

  const expenseAmount = expenses.reduce((s, r) => s + Math.abs(r.amount), 0);
  const revenueAmount = revenues.reduce((s, r) => s + Math.abs(r.amount), 0);

  const named = affected.slice(0, NAMED_LIMIT).map(r => ({
    accountCode: r.accountCode,
    accountName: r.accountName,
    accountType: r.accountType,
    amount: r.amount,
  }));

  const parts: string[] = [];
  if (expenses.length > 0) {
    parts.push(
      `${expenses.length} expense account(s) carrying ${rand(expenseAmount)} have no recognised ` +
      'subtype, so they are shown in operating expenses by default. Any of them that is a cost ' +
      `of sales belongs above the gross profit line — so gross profit is overstated by up to ` +
      `${rand(expenseAmount)}.`,
    );
  }
  if (revenues.length > 0) {
    parts.push(
      `${revenues.length} revenue account(s) carrying ${rand(revenueAmount)} have no recognised ` +
      'subtype, so they are shown as turnover by default. Any of them that is other income ' +
      'overstates revenue.',
    );
  }
  parts.push('Set account_subtype on each account to fix the figures above.');

  return {
    expenseAccounts: expenses.length,
    expenseAmount,
    revenueAccounts: revenues.length,
    revenueAmount,
    grossProfitOverstatedByAtMost: expenseAmount,
    accounts: named,
    unnamedAccounts: affected.length - named.length,
    message: parts.join(' '),
  };
}
