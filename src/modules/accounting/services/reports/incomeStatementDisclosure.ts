/**
 * The income statement's own "this figure rests on a default" disclosure.
 *
 * WHY THIS REPORT SPECIFICALLY. `fetchIncomeStatementRows` puts an expense
 * above the gross profit line only when the shared `expenseBand` says
 * `cost_of_sales`, and a revenue row into turnover unless `revenueBand` says
 * other income. Gross profit is `totalRevenue - totalCostOfSales`, so anything
 * banded by fallback rather than by classification moves it without anyone
 * being told. That is how Velocity read a 96.6% gross margin on fibre
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
 * THE CERTAIN FLOOR IS GONE, AND THAT IS THE POINT. An earlier version of this
 * module reported a floor: revenue accounts recognised as `other_income` that
 * this statement nevertheless showed inside turnover, and therefore inside
 * gross profit — certain, not conjectural. That defect (B75) is FIXED: the
 * report now has an other-income line and agrees with `aggregateFigures` band
 * for band. A correctly-classified other-income account is now correctly
 * placed, so there is nothing certain left to disclose and this module reports
 * only the conjectural half.
 *
 * WHAT REMAINS IS A CEILING. Accounts banded by fallback: an unclassified
 * expense MIGHT be cost of sales; an unclassified revenue MIGHT be other
 * income. Either overstates gross profit one-for-one if it is — the expense by
 * sitting below the line, the revenue by sitting inside turnover. We cannot
 * know which, so the honest claim is an upper bound, never a corrected figure.
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
 * opposite of the fact. No DISCLOSED account carries a credit balance in
 * production today — Brightsphere's `35409454 Legal Expenses` holds
 * -R1,084,773.56 but is classified `operating_expenses`, so this predicate
 * never sees it; the shape is real in the ledger and latent here, which is why
 * the clamp is written and tested rather than deferred. The `…Amount` fields
 * are SIGNED — what the report actually shows — and only the bounds are
 * clamped.
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
  | 'platform_default';

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
   * Expense banded by fallback that could belong above the gross profit line.
   * Debit balances only — a credit-balance expense cannot overstate anything.
   */
  costOfSalesExposureAtMost: number;
  /** Revenue banded by fallback that could be other income rather than turnover. */
  otherIncomeExposureAtMost: number;
  /**
   * The two above summed. A true bound, and deliberately NOT
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

/**
 * Human labels for each reason, so the screen, the CSV and the XLSX describe a
 * reason the same way. An export that says a raw enum where the
 * screen says something readable is the same defect described twice.
 */
export const DISCLOSURE_REASON: Record<DisclosureReason, string> = {
  no_subtype: 'no recognised account_subtype',
  platform_default: 'carries the platform default subtype, i.e. nobody classified it',
};

/** Falls back to the raw value rather than rendering the string `undefined`. */
export const reasonLabel = (reason: string): string =>
  DISCLOSURE_REASON[reason as DisclosureReason] ?? reason;

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

/**
 * Normalised exactly as `canonicalSubtype` normalises, including the
 * space/hyphen collapse. Matching on `.trim().toLowerCase()` alone would let
 * `"Default Expense"` or `"default-expense"` miss this set, canonicalise to
 * `operating_expense`, and be called classified — the precise miss this
 * predicate exists to close.
 */
const isPlatformDefault = (raw: string | null): boolean =>
  PLATFORM_DEFAULTS.has((raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'));

/**
 * Subtypes that actually say something about where a row belongs ON THIS
 * REPORT. A subtype from the other side of the ledger — an expense account
 * carrying `bank`, or `revenue` — canonicalises non-null and would read as a
 * classification, while the report still bands the row by its bare `else`.
 */
const EXPENSE_VOCABULARY: ReadonlySet<string> = new Set([
  'cost_of_sales', 'operating_expense', 'admin_expense', 'depreciation_expense',
  'finance_cost', 'tax_expense', 'other_expense', 'payroll_expense', 'insurance_expense',
]);
const REVENUE_VOCABULARY: ReadonlySet<string> = new Set(['revenue', 'sales', 'other_income']);

/** Why this row is disclosed, or null if its placement is a real classification. */
export function reasonFor(row: DisclosureInputRow): DisclosureReason | null {
  if (isPlatformDefault(row.accountSubtype)) return 'platform_default';
  const canon = canonicalSubtype(row.accountSubtype);
  if (canon === null) return 'no_subtype';
  const vocabulary = row.accountType === 'expense' ? EXPENSE_VOCABULARY : REVENUE_VOCABULARY;
  if (!vocabulary.has(canon)) return 'no_subtype';
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
  // One of each REASON: the headline cites both, so each needs an example.
  for (const reason of ['platform_default', 'no_subtype'] as const) {
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

  const expenseAmount = expenses.reduce((s, r) => s + r.amount, 0);
  const revenueAmount = revenues.reduce((s, r) => s + r.amount, 0);

  // Possible, split — see the docblock. Debits only: a credit-balance expense
  // cannot overstate anything, and neither can a contra-revenue account.
  const costOfSalesExposure = scored
    .filter(r => r.accountType === 'expense')
    .reduce((s, r) => s + Math.max(r.amount, 0), 0);
  const otherIncomeExposure = scored
    .filter(r => r.accountType === 'revenue')
    .reduce((s, r) => s + Math.max(r.amount, 0), 0);
  const ceiling = costOfSalesExposure + otherIncomeExposure;

  const named = pickNamed(scored);

  const notices = buildDataQualityNotices({
    unclassifiedAccounts: {
      accounts: scored.length,
      amount: expenseAmount + revenueAmount,
      message: '',
      byType: [
        ...(expenses.length > 0
          ? [{
              type: 'expense',
              accounts: expenses.length,
              amount: expenseAmount,
              defaultedTo: 'operating expenses rather than cost of sales',
            }]
          : []),
        ...(revenues.length > 0
          ? [{
              type: 'revenue',
              accounts: revenues.length,
              amount: revenueAmount,
              defaultedTo: 'turnover rather than other income',
            }]
          : []),
      ],
    },
    costOfSalesExposureAtMost: costOfSalesExposure,
    otherIncomeExposureAtMost: otherIncomeExposure,
  });

  return {
    expenseAccounts: expenses.length,
    expenseAmount,
    revenueAccounts: revenues.length,
    revenueAmount,
    costOfSalesExposureAtMost: costOfSalesExposure,
    otherIncomeExposureAtMost: otherIncomeExposure,
    grossProfitOverstatedByAtMost: ceiling,
    accounts: named,
    unnamedAccounts: scored.length - named.length,
    notices,
    message: notices.join(' '),
  };
}
