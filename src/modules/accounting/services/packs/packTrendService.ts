/**
 * The pack's twelve-month revenue / expense / profit / margin / cash /
 * debtor-days series.
 *
 * One definition, because the printed PDF fetches it over HTTP while the PPTX
 * exporter calls it in-process; two queries would be two chances to disagree
 * on a document and a deck that a reader compares side by side.
 *
 * Dates are built from local calendar parts, never through toISOString(): on
 * this UTC+2 host `new Date('2026-01-01').toISOString()` is the previous day,
 * which silently drops a month off the front of the series.
 *
 * `cash` and `accountsReceivable` are balance-sheet POSITIONS, not period
 * movement — a month's revenue is what happened IN that month, but a bank
 * balance is what stands at the END of it. Getting that requires everything
 * posted since inception up to each month-end, so the query carries no lower
 * bound on `entry_date` at all; it is the same open-ended "cumulative" shape
 * `financialFiguresService.getFinancialFigures` already uses for its balance
 * sheet, not a new pattern. One query still does it: a CASE bucket folds
 * every posting before the trend window into a single opening balance, and
 * the running total carries forward from there, month by month, in JS.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { marginPct, marginPct2dp } from '@/modules/accounting/services/reports/marginPct';
import {
  CASH_SUBTYPES,
  RECEIVABLE_SUBTYPES,
  rawSubtypesFor,
} from '@/modules/accounting/services/gl/accountSubtypes';

export interface PackTrendPoint {
  /** YYYY-MM */
  month: string;
  /** 'Mar 2026' */
  label: string;
  /**
   * TURNOVER — revenue accounts less the other-income band, which is the
   * measure `aggregateFigures` calls `revenue` and every statement in the pack
   * prints under that name.
   *
   * It used to be every `account_type = 'revenue'` account with no band at
   * all, and that is finding B75 in a second place: the income statement page
   * and the MCP tool once diverged the same way, by exactly the other-income
   * total, and were fixed by banding both sides through the same exported
   * `revenueBand` (see `reportsProfitAndLoss.ts` and
   * `incomeStatementConvergence.test.ts`). This service never got that fix, so
   * the board pack printed Brightsphere's revenue as (5 536) on the trends and
   * group-results sheets against (5 535) on the income statement — the
   * other-income account, to the rand — while its net profit agreed exactly.
   * Net-profit-agrees-and-gross-does-not is the B75 signature.
   */
  revenue: number;
  /**
   * The other-income band of the same accounts, so `revenue + otherIncome` is
   * the old unbanded total and nothing is lost by the split.
   *
   * Carried rather than folded away because page 5 prints the months as an
   * income statement and a row that does not add across is a row a director
   * cannot check.
   */
  otherIncome: number;
  /** Total expense-type movement — cost of sales, operating and below-the-line
   *  combined. Unchanged by this series' extension; see `operatingExpenses`
   *  for the narrower band spec §4.A's panel actually names. */
  expenses: number;
  netProfit: number;
  costOfSales: number;
  /** Everything `expenseBand` puts above the operating line: total expenses
   *  less cost of sales and less finance cost / tax / other expense. Same
   *  partition `accountClassification.expenseBand` uses, so this line and the
   *  classifier can never disagree about what counts as "operating". */
  operatingExpenses: number;
  /** Gross margin %, to 2dp, through `marginPct2dp` — the repo's one
   *  definition. Null when revenue is not positive: a margin on no turnover,
   *  or on a net-credit month, is not a measurement (R-P44). */
  grossMarginPct: number | null;
  /** Cash + bank balance at month end. A balance-sheet position: it is a real
   *  number for every month, including one with no posted movement at all —
   *  the balance simply carries forward unchanged. Never null, never reset
   *  to zero for an inactive month. */
  cash: number;
  /** Trade receivables balance at month end. Same carry-forward rule as cash. */
  accountsReceivable: number;
  /**
   * Days of sales outstanding for the month: `accountsReceivable ÷ that
   * month's revenue × days in that month` — the days-in-month multiplier
   * matches a MONTHLY revenue base, unlike `calculateExtendedRatios.debtorDays`
   * which multiplies by 365 against a period revenue and would overstate a
   * month's figure roughly twelvefold if reused here unchanged.
   *
   * Null when the month has no revenue — the R-P45 case: a debtor book that
   * collected nothing that month does not mean zero days outstanding, it
   * means the ratio has no denominator to be measured against.
   */
  debtorDays: number | null;
}

interface MonthSlot { month: string; label: string; from: string; to: string }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** The `months` calendar months ending with the month containing `to`. */
export function monthSlots(to: string, months: number): MonthSlot[] {
  const [yearPart, monthPart] = to.split('-');
  const endYear = Number(yearPart);
  const endMonth = Number(monthPart); // 1-12
  const count = Math.min(12, Math.max(1, months));

  return Array.from({ length: count }, (_, i) => {
    const offset = endMonth - 1 - (count - 1 - i);
    const year = endYear + Math.floor(offset / 12);
    const monthIndex = ((offset % 12) + 12) % 12;
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    return {
      month: `${year}-${pad(monthIndex + 1)}`,
      label: `${MONTH_NAMES[monthIndex]} ${year}`,
      from: `${year}-${pad(monthIndex + 1)}-01`,
      to: `${year}-${pad(monthIndex + 1)}-${pad(lastDay)}`,
    };
  });
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Expense subtypes reported below the operating line — mirrors
 *  `accountClassification`'s `OTHER_EXPENSE` set, so "operating expenses"
 *  here means exactly what the classifier's `expenseBand` means by it. */
export const COST_OF_SALES_SUBTYPES = rawSubtypesFor('cost_of_sales');
/**
 * The other-income band, in the raw spellings the column carries.
 *
 * `rawSubtypesFor`, the same call the two expense bands below already use, so
 * this query bands revenue by exactly the alias table `revenueBand` resolves
 * through — matching the classifier rather than deriving the split again. A
 * NULL subtype is not in any alias list and `= ANY(...)` is false for it, which
 * is `revenueBand(null) === 'turnover'`: the same default, arrived at the same
 * way. `packTrendBanding.test.ts` holds the three arrays to the classifier's
 * own answer over every alias it knows.
 */
export const OTHER_INCOME_SUBTYPES = rawSubtypesFor('other_income');
export const BELOW_OPERATING_LINE_SUBTYPES = rawSubtypesFor('finance_cost', 'tax_expense', 'other_expense');

/** Sentinel month bucket for every posting strictly before the trend window
 *  — sorts before every real 'YYYY-MM' key, though nothing here relies on
 *  sort order; it is only ever looked up by this literal key. */
const OPENING_BUCKET = '__opening__';

export async function getPackTrend(companyId: string, to: string, months = 12): Promise<PackTrendPoint[]> {
  const slots = monthSlots(to, months);
  const first = slots[0]!;
  const last = slots[slots.length - 1]!;

  /**
   * The series stops at the REPORTING DATE, not at the end of the calendar
   * month containing it.
   *
   * `cash` and `accountsReceivable` are cumulative positions, so the last
   * month's bucket carried every posting to that month's last day — and a
   * board pack run to 7 September read cash as at 30 September. Sheet 8 of
   * the rendered pack stated closing cash as `(532)` in its table and
   * `(752)` in the closing-cash line's own title, on the same page, both at
   * R'000, with nothing to say the two were measured over different windows.
   * A pack must not report a position it is not yet reporting on.
   *
   * `monthSlots` still gives every month its real last day — that is what a
   * month IS, and its own test says so. Only the query's upper bound is
   * clamped, and only when `to` falls mid-month.
   */
  const upperBound = to < last.to ? to : last.to;

  const rows = (await sql`
    SELECT
      CASE WHEN je.entry_date < ${first.from}::date THEN ${OPENING_BUCKET}
           ELSE to_char(je.entry_date, 'YYYY-MM') END AS month,
      COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' AND je.entry_date >= ${first.from}::date THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue_and_other_income,
      COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' AND ga.account_subtype = ANY(${OTHER_INCOME_SUBTYPES as string[]}::TEXT[]) AND je.entry_date >= ${first.from}::date THEN jl.credit - jl.debit ELSE 0 END), 0) AS other_income,
      COALESCE(SUM(CASE WHEN ga.account_type = 'expense' AND je.entry_date >= ${first.from}::date THEN jl.debit - jl.credit ELSE 0 END), 0) AS expenses,
      COALESCE(SUM(CASE WHEN ga.account_type = 'expense' AND ga.account_subtype = ANY(${COST_OF_SALES_SUBTYPES as string[]}::TEXT[]) AND je.entry_date >= ${first.from}::date THEN jl.debit - jl.credit ELSE 0 END), 0) AS cost_of_sales,
      COALESCE(SUM(CASE WHEN ga.account_type = 'expense' AND ga.account_subtype = ANY(${BELOW_OPERATING_LINE_SUBTYPES as string[]}::TEXT[]) AND je.entry_date >= ${first.from}::date THEN jl.debit - jl.credit ELSE 0 END), 0) AS below_operating_line,
      COALESCE(SUM(CASE WHEN ga.account_type = 'asset' AND ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[]) THEN jl.debit - jl.credit ELSE 0 END), 0) AS cash_movement,
      COALESCE(SUM(CASE WHEN ga.account_type = 'asset' AND ga.account_subtype = ANY(${RECEIVABLE_SUBTYPES as string[]}::TEXT[]) THEN jl.debit - jl.credit ELSE 0 END), 0) AS receivable_movement
    FROM   gl_journal_lines  jl
    JOIN   gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN   gl_accounts        ga ON ga.id = jl.gl_account_id
    WHERE  je.company_id = ${companyId}::UUID
      AND  jl.company_id = ${companyId}::UUID
      AND  ga.company_id = ${companyId}::UUID
      AND  je.status     = 'posted'
      AND  je.entry_date <= ${upperBound}::date
    GROUP  BY 1
  `) as Row[];

  const byMonth = new Map(rows.map((r) => [String(r.month), r]));
  const opening = byMonth.get(OPENING_BUCKET);
  // Seeded from everything before the window, then carried forward month by
  // month below — the real month-end balance, not just movement inside the
  // window the trend happens to cover.
  let cashRunning = num(opening?.cash_movement);
  let receivableRunning = num(opening?.receivable_movement);

  const points = slots.map((slot) => {
    const row = byMonth.get(slot.month);
    // TURNOVER BY DIFFERENCE, so the two bands cannot fail to sum to the
    // total the query read — the same construction the operating band uses
    // one line down, and the reason page 5's rows add across to the cent.
    const revenueAndOtherIncome = num(row?.revenue_and_other_income);
    const otherIncome = round2(num(row?.other_income));
    const revenue = round2(revenueAndOtherIncome - otherIncome);
    const expenses = num(row?.expenses);
    const costOfSales = num(row?.cost_of_sales);
    const operatingExpenses = round2(expenses - costOfSales - num(row?.below_operating_line));

    // Balances carry forward: a month with no posted movement (no row at
    // all) adds zero and keeps the prior month's real closing position,
    // never a reset to zero.
    cashRunning = round2(cashRunning + num(row?.cash_movement));
    receivableRunning = round2(receivableRunning + num(row?.receivable_movement));

    // ON TURNOVER, which is the base the income statement's gross margin uses.
    // It was on turnover PLUS other income, so page 10's gross-margin panel
    // and page 6's gross margin were quotients of different denominators.
    const grossMarginPct = marginPct2dp(revenue - costOfSales, revenue);

    const debtorPct = marginPct(receivableRunning, revenue);
    const daysInMonth = Number(slot.to.slice(-2));
    const debtorDays = debtorPct === null ? null : round2((debtorPct / 100) * daysInMonth);

    return {
      month: slot.month,
      label: slot.label,
      revenue,
      otherIncome,
      expenses,
      // NET PROFIT IS UNTOUCHED BY THE BAND, and that is what makes this a
      // reclassification rather than a restatement: it is still every revenue
      // account less every expense account, now written as the two bands that
      // replaced the one. `incomeStatementConvergence.test.ts` pins the same
      // invariant on the statement side.
      netProfit: round2(revenueAndOtherIncome - expenses),
      costOfSales: round2(costOfSales),
      operatingExpenses,
      grossMarginPct,
      cash: cashRunning,
      accountsReceivable: receivableRunning,
      debtorDays,
    };
  });

  log.info('getPackTrend', { companyId, to, months: points.length }, 'packs');
  return points;
}
