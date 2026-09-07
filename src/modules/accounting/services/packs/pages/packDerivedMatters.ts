/**
 * THE MATTERS THE PACK DERIVES FROM ITS OWN SERIES, rather than from a query.
 *
 * `packMatters.ts` reads the ledger — four checks, four queries, and the whole
 * module is mocked wholesale by the tests that hold `buildBoardPackDocument`
 * to one tenant. Nothing here reads anything: it takes the trend the pack has
 * already drawn and turns one of its facts into a line on page 11, which is
 * why it is its own file rather than a fifth entry in that module's SOURCES.
 */
import { round2 } from '@/modules/accounting/services/reconciliation/reconciliationMath';
import { formatMoney, inProse, type MoneyScale } from '@/lib/format/money';
import { NO_PRIOR_MEETING_RECORD, type PackMatter } from './packMatters';
import { monthLabel } from './packPartialMonth';
import {
  profitStanding,
  type ProfitStanding,
} from '@/modules/accounting/services/packs/narrative/statedRelation';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/**
 * WHAT THE CREDIT DID TO THE MONTH'S RESULT, AGAINST THE PERIOD'S — one
 * clause per case, and the case is COMPUTED from the two net profits rather
 * than inferred from the fact that expenses were a credit.
 *
 * The first of these is the sentence the tenth visual gate blocked on. It
 * printed on Brightsphere, whose April net profit is (1 408) against a period
 * net profit of (1 408) — the same loss — while page 5's table, page 5's own
 * title ("lowest at (1 408) in Apr 2026") and page 6 each disprove it. The
 * clause fired whenever expenses were a net credit and never tested whether
 * the month was in profit; it was true on the demo pack, which is the only
 * reason it survived three reviews.
 *
 * Every one of the four states a relation between two figures the pack
 * prints — page 5 carries the month, page 6 carries the period — so a
 * director can check any of them off the paper. None of them claims the
 * credit CAUSED the standing: the credit's size is the row's quantum and the
 * addition is stated after this clause, which is as far as the figures go.
 *
 * A `Record` over the union rather than a chain of `if`s: a fifth case cannot
 * be added without a wording, and the case a fixture never reaches is one the
 * author had to write down. See `statedRelation.ts`.
 */
const CREDIT_MONTH_STANDING: Record<ProfitStanding, string> = {
  profitWherePeriodHasNone: 'so the month reports a profit the period does not',
  profitAsThePeriodDoes: 'so the month reports a profit, as the period does',
  lossWherePeriodHasProfit: 'so the month reports a loss the period does not',
  lossAsThePeriodDoes: 'so the month reports a loss even with the credit, as the period does',
};

/**
 * A MONTH WHOSE EXPENSES ARE A NET CREDIT IS A MATTER, AND NO DATABASE CHECK
 * COULD SEE IT.
 *
 * The rendered demo pack drew a net profit of +1 908 R'000 for July 2026 in a
 * company reporting R100k of revenue for the whole period, said on the trends
 * panel that the month's expenses were a net credit — and no matter on page 11
 * referred to it. That silence was not an oversight of ranking: the cause was
 * seven payroll journals dated 2031 reversed into July, and every check that
 * feeds this page misses them by construction. `getUnusualJournals` selects on
 * `entry_date BETWEEN` the reporting window, so the 2031 originals are not in
 * the result set at all, and it flags an entry only when it was RECORDED WELL
 * AFTER its entry date — a reversal dated and posted in the same July is
 * neither late nor a round number.
 *
 * So the matter is derived from the series the pack already draws, which is
 * where the anomaly is visible: a month in which more was reversed out of
 * expense accounts than was posted into them. That is a statement about the
 * ledger taken from a field the trend already carries, it names no journal
 * this model has not read, and it is the same fact `creditMonthClause` prints
 * on the panel — one derivation, two pages, so the largest visual event in the
 * document stops being one the governance page has never heard of.
 */
export function creditMonthMatters(
  trend: PackTrendPoint[],
  scale: MoneyScale,
  /** The PERIOD's net profit — the figure page 6 prints. Required, because
   *  the clause below states how the month stands against it and a sentence
   *  that states a comparison must take the comparison's result as an input.
   *  See `CREDIT_MONTH_STANDING`. */
  periodNetProfit: number,
): PackMatter[] {
  const money = (n: number) => inProse(formatMoney(n, { scale }));
  return trend.filter((point) => point.expenses < 0).map((point) => ({
    kind: 'finding' as const,
    // AND IT SAYS WHICH NUMBER IT IS, BECAUSE THE PACK PRINTS TWO FOR THIS
    // MONTH. The trends panel quantifies July at 1 908 and this row quantifies
    // it at 1 869 — a reader meeting both takes them for one quantity stated
    // twice, which is the defect class this pack has fixed four times. They
    // are two quantities: the panel plots the month's NET PROFIT and this
    // quantum is the EXPENSE CREDIT alone.
    //
    // THE SENTENCE JOINING THEM SAID "larger by the month's revenue" AND WAS
    // FALSE ON BOTH COMPANIES. `getPackTrend` defines a month's net profit as
    // `revenue + otherIncome − expenses`, so where expenses are a credit the
    // identity is `netProfit = credit + revenue + otherIncome` — the two
    // income BANDS, not turnover alone. Demo July: 1 869 + 37 + 2 = 1 908,
    // and the sentence was out by the other income. Brightsphere April is the
    // direction as well as the magnitude: 4 128 + (5 535) + (1) = (1 408), a
    // net profit 5 536 BELOW the credit, on a month whose turnover is
    // negative — so "larger by the revenue" was wrong in sign, on the page
    // before the sheet that disproves it.
    //
    // The identity is stated with its three figures rather than as a
    // relation, because a relation has to be true in every direction and
    // these figures are true as printed: both bands are columns of page 5's
    // table for this month, so the addition is one a director can take off
    // the sheet. It holds for a negative turnover, for nil other income, and
    // by construction rather than by the arithmetic of one company — all
    // three are read off the same `PackTrendPoint`.
    //
    // The panel is left alone deliberately: it sits inside a 48mm box on the
    // tightest page in the pack, its own title already says which measure it
    // plots, and every word added there is a line the chart loses. The column
    // that says nothing about what its number is, is this one.
    issue: `${monthLabel(point)}: expenses for the month are a net credit — more was reversed out of `
      + 'expense accounts than was posted into them, '
      + `${CREDIT_MONTH_STANDING[profitStanding(point.netProfit, periodNetProfit)]}`
      // AND IT IS NO LONGER THAN THE SENTENCE IT REPLACES, WHICH IS NOT A
      // STYLE POINT. Page 11's table is budgeted in LINES of paper
      // (`mattersBudgetMm`), so a longer issue prints one fewer matter and
      // moves a real R339k exposure into the unprinted tail — the first
      // draft of this cost the demo pack a row. Three figures and the
      // addition between them, in the words the row already had.
      + `. The quantum is that credit, ${money(creditOf(point))}; the trends panel's net profit `
      + `of ${money(point.netProfit)} is that credit plus revenue and other income of `
      + `${money(incomeOf(point))}.`,
    quantum: round2(creditOf(point)),
    owner: 'Finance',
    movement: NO_PRIOR_MEETING_RECORD,
    decisionRequired: 'Identify the reversals behind the credit and confirm the period they belong to.',
  }));
}

/** The size of the credit — the quantum this row carries, and the first of
 *  the three figures its sentence states. */
function creditOf(point: PackTrendPoint): number {
  return Math.abs(point.expenses);
}

/** THE TWO INCOME BANDS TOGETHER, which is what separates the credit from the
 *  month's net profit. Turnover alone was the old answer and it was short by
 *  the other-income band — see the sentence above. */
function incomeOf(point: PackTrendPoint): number {
  return round2(point.revenue + point.otherIncome);
}

/**
 * Every matter the pack has, with the derived ones added — and the "every
 * check ran clean" line removed where they are, because a page cannot carry
 * both.
 */
export function withDerivedMatters(
  matters: PackMatter[],
  trend: PackTrendPoint[],
  scale: MoneyScale,
  periodNetProfit: number,
): PackMatter[] {
  const derived = creditMonthMatters(trend, scale, periodNetProfit);
  if (derived.length === 0) return matters;
  return [...matters.filter((m) => m.kind !== 'none'), ...derived];
}
