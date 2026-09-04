/**
 * The income statement's own "this figure rests on a default" disclosure.
 *
 * WHY THIS REPORT SPECIFICALLY. `fetchIncomeStatementRows` puts an expense
 * above the gross profit line only when `canonicalSubtype` says
 * `cost_of_sales`, and puts EVERY revenue row into turnover — this report has
 * no other-income line at all. So gross profit here is
 * `totalRevenue - totalCostOfSales`, and three different things move it without
 * anyone being told. That is how Velocity read a 96.6% gross margin on fibre
 * construction against a real -1.9% (finding B61).
 *
 * WHAT COUNTS AS "NOT REALLY CLASSIFIED" — the first cut got this too narrow.
 * It asked only `canonicalSubtype(...) === null`, which misses the platform's
 * OWN default markers:
 *
 *   `default_expense`  canonicalises to `operating_expense`
 *   `default_revenue`  canonicalises to `revenue`
 *
 * Those are seeded by migrations 200/476/605 on system accounts and mean
 * precisely "nobody has classified this" — the one subtype whose name says it
 * is unclassified was being read as a classification. Brightsphere's
 * `5001 Cost of Goods Sold` (system, `default_expense`) holds R574,253.66 and
 * was invisible, on the company whose income statement prints a 100.0% gross
 * margin against R0.00 of cost of sales. `canonicalSubtype` is deliberately NOT
 * changed here: it is read by ten other report surfaces and moving money on all
 * of them is a separate decision with its own evidence. This report states its
 * own predicate and says why.
 *
 * A FLOOR AND A CEILING, BECAUSE THEY ARE DIFFERENT CLAIMS.
 *
 *   CERTAIN (the floor) — a revenue account whose subtype IS recognised as
 *   `other_income`. This report has no other-income line, so it is inside
 *   turnover and inside gross profit, definitely, today. Nothing is conjectural
 *   about it and no reclassification is needed to know it is wrong.
 *
 *   POSSIBLE (the ceiling) — accounts banded by fallback. An unclassified
 *   expense MIGHT be cost of sales; an unclassified revenue MIGHT be other
 *   income. Both overstate gross profit one-for-one if they are, because of
 *   the missing other-income line. We cannot know which, so the honest claim is
 *   an upper bound, never a corrected figure.
 *
 * Reporting only the ceiling trains a reader to ignore amber: Brightsphere's
 * ceiling is millions while its certain error is R23,323.42. Reporting only the
 * floor hides Velocity's exposure. Both, labelled.
 *
 * AND THE CEILING IS REPORTED AS TWO NUMBERS, NOT ONE. Summed, Velocity's is
 * R200,037,895.31 against R84,053,370.26 of revenue — arithmetically a true
 * bound and worthless as information, because it says gross profit could be
 * anything down to minus R119m. The two halves are different questions with
 * different remedies, so they are stated separately: how much EXPENSE could
 * belong above the line as cost of sales, and how much REVENUE could be other
 * income. A reader can act on either; nobody can act on their sum.
 *
 * THE CEILING COUNTS DEBIT BALANCES ONLY. Expenses are signed `debit - credit`,
 * so a reversal, rebate or recovery arrives NEGATIVE and REDUCES operating
 * expenses — reclassifying it upward would RAISE gross profit, and the only
 * possible error direction is understatement. Summing absolutes would state the
 * opposite of the fact. Brightsphere carries the shape live: `35409454 Legal
 * Expenses` holds -R1,084,773.56. The `…Amount` fields are SIGNED — what the
 * report actually shows — and only the bound is clamped.
 *
 * WORDING IS NOT DUPLICATED. `buildDataQualityNotices` already owns the
 * sentences and the `R 1 000,00` format ten other report surfaces show. This
 * module hands it structured numbers and adds only the sentences those surfaces
 * cannot say. Two wordings and two number formats for one defect, on screens a
 * user compares, is its own kind of wrong.
 */

import { canonicalSubtype } from '../gl/accountClassification';
import { buildDataQualityNotices } from './dataQualityNotices';

/** One income statement row, already signed the way the report signs it. */
export interface DisclosureInputRow {
  accountCode: string;
  accountName: string;
  accountType: 'revenue' | 'expense';
  accountSubtype: string | null;
  /** Report-signed amount: credit-debit for revenue, debit-credit for expense. */
  amount: number;
}

/** Why this account's placement is not a classification. */
export type DisclosureReason =
  /** No subtype, or one the classifier does not recognise. */
  | 'no_subtype'
  /** The platform's own "nobody classified this" marker. */
  | 'platform_default'
  /** Recognised as other income, but this report has no other-income line. */
  | 'other_income_in_turnover';

export interface DisclosureAccount {
  accountCode: string;
  accountName: string;
  accountType: 'revenue' | 'expense';
  amount: number;
  reason: DisclosureReason;
}

export interface IncomeStatementSubtypeDisclosure {
  expenseAccounts: number;
  /** SIGNED net of those accounts — what the report actually shows for them. */
  expenseAmount: number;
  revenueAccounts: number;
  /** SIGNED net of those accounts. */
  revenueAmount: number;
  /**
   * Gross profit is overstated by AT LEAST this — other income sitting inside
   * turnover. Certain today; no reclassification needed to know it.
   */
  grossProfitOverstatedByAtLeast: number;
  /**
   * Expense banded by fallback that could belong above the gross profit line.
   * Debit balances only — a credit-balance expense cannot overstate anything.
   */
  costOfSalesExposureAtMost: number;
  /** Revenue banded by fallback that could be other income rather than turnover. */
  otherIncomeExposureAtMost: number;
  /**
   * The two above plus the certain floor. A true bound, and deliberately NOT
   * the headline: on Velocity it exceeds revenue itself. Kept because an export
   * cell and a machine reader want one comparable number.
   */
  grossProfitOverstatedByAtMost: number;
  /** Largest offenders, with at least one of each reason present. */
  accounts: DisclosureAccount[];
  unnamedAccounts: number;
  /** Sentences for a surface to render. */
  notices: string[];
  /** The same sentences joined, for exports that carry a single cell. */
  message: string;
}

/** Below a tenth of a cent is not worth a banner. */
const MATERIAL = 0.001;

/** How many accounts to name before summarising the rest. */
const NAMED_LIMIT = 6;

/**
 * Subtypes the platform seeds to mean "not classified yet". They canonicalise
 * to a real band, so `canonicalSubtype` cannot see them — but a default applied
 * because nobody chose is exactly what this report has to disclose.
 */
const PLATFORM_DEFAULTS: ReadonlySet<string> = new Set(['default_expense', 'default_revenue']);

const isPlatformDefault = (raw: string | null): boolean =>
  PLATFORM_DEFAULTS.has((raw ?? '').trim().toLowerCase());

/** Why this row is disclosed, or null if its placement is a real classification. */
export function reasonFor(row: DisclosureInputRow): DisclosureReason | null {
  if (isPlatformDefault(row.accountSubtype)) return 'platform_default';
  const canon = canonicalSubtype(row.accountSubtype);
  if (canon === null) return 'no_subtype';
  if (row.accountType === 'revenue' && canon === 'other_income') return 'other_income_in_turnover';
  return null;
}

/**
 * Named list: largest first, but guarantee one of each reason present. Slicing
 * a single sorted list can name six revenue accounts under a headline about
 * gross profit, leaving nothing that supports it.
 */
function pickNamed(scored: readonly DisclosureAccount[]): DisclosureAccount[] {
  const chosen: DisclosureAccount[] = [];
  const take = (r: DisclosureAccount | undefined) => {
    if (r && !chosen.includes(r)) chosen.push(r);
  };
  // One of each REASON: the headline cites all three, so each needs an example.
  for (const reason of ['other_income_in_turnover', 'platform_default', 'no_subtype'] as const) {
    take(scored.find(r => r.reason === reason));
  }
  // ...and one of each TYPE: six large revenue accounts would otherwise crowd
  // out every expense under a headline about cost of sales.
  for (const type of ['expense', 'revenue'] as const) {
    take(scored.find(r => r.accountType === type));
  }
  for (const r of scored) {
    if (chosen.length >= NAMED_LIMIT) break;
    take(r);
  }
  return chosen.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

/** Build the disclosure, or null when there is nothing to say. */
export function buildIncomeStatementSubtypeDisclosure(
  rows: readonly DisclosureInputRow[],
): IncomeStatementSubtypeDisclosure | null {
  const scored: DisclosureAccount[] = [];
  for (const r of rows) {
    if (Math.abs(r.amount) < MATERIAL) continue;
    const reason = reasonFor(r);
    if (reason === null) continue;
    scored.push({
      accountCode: r.accountCode,
      accountName: r.accountName,
      accountType: r.accountType,
      amount: r.amount,
      reason,
    });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const expenses = scored.filter(r => r.accountType === 'expense');
  const revenues = scored.filter(r => r.accountType === 'revenue');
  const certain = scored.filter(r => r.reason === 'other_income_in_turnover');
  const possible = scored.filter(r => r.reason !== 'other_income_in_turnover');

  const expenseAmount = expenses.reduce((s, r) => s + r.amount, 0);
  const revenueAmount = revenues.reduce((s, r) => s + r.amount, 0);

  // Certain: other income already inside turnover, so already inside gross profit.
  const floor = certain.reduce((s, r) => s + Math.max(r.amount, 0), 0);
  // Possible, split — see the docblock. Debits only: a credit-balance expense
  // cannot overstate anything, and neither can a contra-revenue account.
  const costOfSalesExposure = possible
    .filter(r => r.accountType === 'expense')
    .reduce((s, r) => s + Math.max(r.amount, 0), 0);
  const otherIncomeExposure = possible
    .filter(r => r.accountType === 'revenue')
    .reduce((s, r) => s + Math.max(r.amount, 0), 0);
  const ceiling = floor + costOfSalesExposure + otherIncomeExposure;

  const named = pickNamed(scored);

  const notices = buildDataQualityNotices({
    unclassifiedAccounts: {
      accounts: possible.length,
      amount: expenseAmount + revenueAmount,
      message: '',
      byType: [
        ...(expenses.some(r => r.reason !== 'other_income_in_turnover')
          ? [{
              type: 'expense',
              accounts: expenses.filter(r => r.reason !== 'other_income_in_turnover').length,
              amount: expenseAmount,
              defaultedTo: 'operating expenses rather than cost of sales',
            }]
          : []),
        ...(revenues.some(r => r.reason !== 'other_income_in_turnover')
          ? [{
              type: 'revenue',
              accounts: revenues.filter(r => r.reason !== 'other_income_in_turnover').length,
              amount: revenueAmount,
              defaultedTo: 'turnover rather than other income',
            }]
          : []),
      ],
    },
    grossProfitOverstatedByAtLeast: floor,
    costOfSalesExposureAtMost: costOfSalesExposure,
    otherIncomeExposureAtMost: otherIncomeExposure,
    otherIncomeInTurnover: certain.length > 0
      ? { accounts: certain.length, amount: floor }
      : null,
  });

  return {
    expenseAccounts: expenses.length,
    expenseAmount,
    revenueAccounts: revenues.length,
    revenueAmount,
    grossProfitOverstatedByAtLeast: floor,
    costOfSalesExposureAtMost: costOfSalesExposure,
    otherIncomeExposureAtMost: otherIncomeExposure,
    grossProfitOverstatedByAtMost: ceiling,
    accounts: named,
    unnamedAccounts: scored.length - named.length,
    notices,
    message: notices.join(' '),
  };
}
