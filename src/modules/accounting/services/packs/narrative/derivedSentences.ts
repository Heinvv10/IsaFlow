/**
 * Deterministic TITLES for pack pages, and the two disclosure sentences that
 * belong beside them. The block-level CAPTIONS moved to `derivedCaptions.ts`
 * when this file hit the 300-line ceiling and are re-exported at the bottom,
 * so every existing import path still resolves.
 *
 * Every function here is `derived` in the approved/derived commentary split:
 * a pure string built from figures already on the pack, never model output.
 * A pack page a director forwards to a bank must never carry a sentence that
 * cannot be traced back to a number someone can check — that traceability is
 * the whole reason this file has no service call, no `Date.now()`, and no
 * branch that depends on anything but its arguments.
 *
 * SCALE IS A REQUIRED ARGUMENT WHEREVER A FIGURE IS PRINTED (R-P52).
 * Scaling is a display concern owned by `formatMoney`; the model's figures
 * stay RAW so the integrity gate keeps comparing raw values. It was the
 * TABLES that were wired for the document's scale and the PROSE that was
 * not, so page 6 printed revenue as `99` under an `R'000` header and, three
 * centimetres below, "Revenue of 98 800" — the same figure, twice, a
 * thousand apart. A required parameter is what makes forgetting it a compile
 * error rather than a board pack a director misreads by three orders of
 * magnitude.
 *
 * Every percentage goes through `marginPct`, which returns null on a
 * non-positive base. That guard is reused here for period-on-period change,
 * not just for margins — a change measured off a negative or zero comparative
 * is exactly as meaningless as a margin on non-positive turnover, for the same
 * reason: the sign of the result stops tracking the sign of the story.
 *
 * Every percentage is rendered through `pctWithWord`, the same rounding
 * convention `formatPct` uses for the tables beside these captions — a
 * hand-rolled `Math.round(...)+'%'` here would print "12%" in prose against
 * "+12.0%" in the table for the same change, which is the mixed
 * number-convention failure spec §7.1 criterion 8 exists to stop.
 *
 * AND EVERY PERCENTAGE NAMES ITS OWN DIRECTION. `pctWithWord` takes the two
 * words this sentence uses for up and down and there is no way to get an
 * undirected percentage out of `money.ts` at all — because two sentences
 * here once printed a bare magnitude ("Operating margin is 1564.3%.",
 * "Gross margin of 1348.0% carried…") above tables reading the negative of
 * exactly that, on a pack that went to a board.
 */

import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { pctWithWord, type MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { scoredTargetsSentence } from './derivedCaptions';
import { money, pctChangeClause, UNCHANGED } from './derivedProseFigures';

export { failedChecksClause, narrativeTitle } from './derivedMattersTitle';
export { trendsTitle } from './derivedTrendsTitle';
export {
  impossibleBalancesSentence,
  impossibleIncomeLinesSentence,
  negativeEquitySentence,
} from './derivedSignDisclosures';
export type { ImpossibleIncomeSide, ImpossibleSide } from './derivedSignDisclosures';

export {
  boardActionItems,
  boardActionMatters,
  cashCaption,
  largestMoverCaption,
  positionCaption,
  scorecardCaption,
  scorecardScore,
  scoredTargetsSentence,
  tileCaption,
  trendsCaption,
} from './derivedCaptions';

/**
 * The no-margin wording for THIS page's margin line, which reads operating
 * profit — not `reportPackService.ts`'s `NO_MARGIN_SENTENCE`, which names
 * net profit verbatim and has its own live caller there. Naming the wrong
 * line in a fallback sentence is the same false-statement defect this pack
 * was rejected for; the two constants must not be merged just because they
 * share a guard.
 */
const NO_OPERATING_MARGIN_SENTENCE =
  'There is no meaningful operating margin on non-positive turnover.';

/**
 * The shared "no comparative base" clause. `measure` NAMES the measure —
 * 'revenue', 'net profit', 'cash' — in lower case, and this composes the
 * sentence around it. `midSentence` leaves the first word lower-cased for use
 * after a semicolon; otherwise the sentence is capitalised.
 *
 * WHERE IT PRINTS IS NOW THE FOOTNOTE APPARATUS, NOT THE HEADLINE. Sheets 3
 * and 4 led with it — "Revenue has no positive comparative base for a
 * percentage change. Operating margin is a negative 1522.9%." — so the first
 * line a director read on a page of real losses was an explanation of a
 * denominator. The disclosure is kept and it is exactly the same sentence;
 * the headline slot goes to the finding and this goes under the rule with
 * the page's other notes. Sheet 8's cash title keeps it mid-sentence: that
 * page's headline is a level and the clause completes it rather than
 * displacing it.
 *
 * IT TAKES THE MEASURE, NOT A WHOLE SUBJECT PHRASE, and that is the fix
 * rather than a wording preference. Callers used to hand in the subject, and
 * two of them handed in one that already named the base — so the negative
 * branch composed a base measured against a base, printed as the second
 * sentence a director reads on sheets 4 and 8. With the measure as the
 * argument there is no phrasing a caller can pass that makes the sentence eat
 * itself.
 */
function noComparativeBaseSentence(measure: string, base: number, midSentence = false): string {
  const s = base < 0
    ? `the comparative ${measure} figure is negative, so the percentage change is not meaningful.`
    : `${measure} has no positive comparative base for a percentage change.`;
  return midSentence ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

export function highlightsTitle(set: PackFigureSet, scale: MoneyScale): string {
  const { current, prior } = set;
  let revenueClause: string;
  if (prior === null) {
    revenueClause = `Revenue is ${money(current.revenue, scale)}, with no comparative period.`;
  } else {
    const change = pctChangeClause(current.revenue, prior.revenue);
    // THE LEVEL, NOT THE REASON THERE IS NO PERCENTAGE. The reason is a
    // footnote on this page — see `highlightsComparativeFootnote`.
    revenueClause = change === null
      ? `Revenue of ${money(current.revenue, scale)}.`
      : `Revenue ${change} against the prior period.`;
  }

  // `?? 0` here printed "Operating margin is 0.0%" on a page whose own tile
  // showed 750 000, because `operatingProfit` is OPTIONAL and a defaulted
  // zero is not the classifier saying the company broke even. One reading of
  // the operating line, `packMetricReads.operatingProfitOf`, for every page
  // and every sentence — a title that contradicts the figure beside it ships
  // silently, which is worse than the render failure it replaced.
  const margin = marginPct(operatingProfitOf(current), current.revenue);
  const marginClause = margin === null
    ? NO_OPERATING_MARGIN_SENTENCE
    : `Operating margin is ${pctWithWord(margin, 'a positive', 'a negative', 'nil')}.`;

  return `${revenueClause} ${marginClause}`;
}

export function positionTitle(set: PackFigureSet, scale: MoneyScale): string {
  const equity = set.current.totalEquity;
  if (equity < 0) {
    return `Negative equity of ${money(equity, scale)}.`;
  }
  if (set.prior) {
    const change = pctChangeClause(equity, set.prior.totalEquity);
    if (change !== null) {
      return `Equity is ${change} ${change === UNCHANGED ? 'at' : 'to'} ${money(equity, scale)}.`;
    }
  }
  return `Equity of ${money(equity, scale)}.`;
}

export function cashTitle(set: PackFigureSet, scale: MoneyScale): string {
  const cash = set.current.cash;
  if (set.prior === null) {
    return `Cash stands at ${money(cash, scale)}, with no comparative period.`;
  }
  const change = pctChangeClause(cash, set.prior.cash);
  if (change === null) {
    return `Cash stands at ${money(cash, scale)}; ${noComparativeBaseSentence('cash', set.prior.cash, true)}`;
  }
  return `Cash is ${change} ${change === UNCHANGED ? 'at' : 'to'} ${money(cash, scale)}.`;
}

/**
 * Page 9's title.
 *
 * It was `Scorecard | 0 of 3 targets met` — the page's own name, then a pipe,
 * then the conclusion. The name is already printed as the 16pt heading
 * directly above this line, so the prefix restated it and pushed the sentence
 * a reader is meant to land on to the right of a rule.
 */
export function scorecardTitle(met: number, total: number): string {
  if (total === 0) return scoredTargetsSentence(0, 0);
  return `${scoredTargetsSentence(met, total)}.`;
}

/**
 * Page 6's title — how the result was EARNED, so it reads the margin rather
 * than restating the profit page 5 already led with.
 *
 * IT NAMES THE MARGIN'S OWN DENOMINATOR, AND NOTHING ELSE. Both branches used
 * to end on the operating expenses — "Gross margin is a negative 1310.8%,
 * carrying operating expenses of 227" and "Revenue of (5 535) carries no
 * meaningful margin base against operating expenses of (3 717)" — and neither
 * relation exists. A gross margin does not carry operating expenses: the two
 * quantities are on opposite sides of the gross-profit line, and "carrying"
 * and "against" were doing the work of a comma. The eleventh gate read both
 * as template seams in the largest type on the page, which is what they were:
 * a figure needed a companion and the next figure down the table was taken.
 *
 * Revenue IS the margin's relation — it is the denominator the percentage was
 * computed on — so the sentence states a relation the figures are actually in
 * and a reader can check off the table below it. The cost base is not lost:
 * the caption under the same table names the line that moved most in money
 * (`largestMoverCaption`), which is the question "carrying" was pretending to
 * answer.
 */
export function incomeStatementTitle(set: PackFigureSet, scale: MoneyScale): string {
  const { current } = set;
  const margin = marginPct(current.revenue - current.costOfSales, current.revenue);
  return margin === null
    ? `Revenue of ${money(current.revenue, scale)} gives no meaningful margin base.`
    : `Gross margin is ${pctWithWord(margin, 'a positive', 'a negative', 'nil')} on revenue of `
      + `${money(current.revenue, scale)}.`;
}
