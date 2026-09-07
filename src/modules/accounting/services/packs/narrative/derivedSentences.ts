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
import { formatMoney, pctWithWord, type MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { scoredTargetsSentence } from './derivedCaptions';

export {
  boardActionItems,
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

/** "up 12.0%" / "down 7.0%", or null when the base is not usable. */
function pctChangeClause(current: number, prior: number): string | null {
  const pct = marginPct(current - prior, prior);
  if (pct === null) return null;
  return pctWithWord(pct, 'up', 'down');
}

/**
 * The shared "no comparative base" clause. `measure` NAMES the measure —
 * 'revenue', 'net profit', 'cash' — in lower case, and this composes the
 * sentence around it. `midSentence` leaves the first word lower-cased for use
 * after a semicolon; otherwise the sentence is capitalised.
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
    revenueClause = `Revenue is ${formatMoney(current.revenue, { scale })}, with no comparative period.`;
  } else {
    const change = pctChangeClause(current.revenue, prior.revenue);
    revenueClause = change === null
      ? noComparativeBaseSentence('revenue', prior.revenue)
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
    : `Operating margin is ${pctWithWord(margin, 'a positive', 'a negative')}.`;

  return `${revenueClause} ${marginClause}`;
}

export function positionTitle(set: PackFigureSet, scale: MoneyScale): string {
  const equity = set.current.totalEquity;
  if (equity < 0) {
    return `Balance sheet position: negative equity of ${formatMoney(equity, { scale })}.`;
  }
  if (set.prior) {
    const change = pctChangeClause(equity, set.prior.totalEquity);
    if (change !== null) {
      return `Equity is ${change} to ${formatMoney(equity, { scale })}.`;
    }
  }
  return `Balance sheet position: equity of ${formatMoney(equity, { scale })}.`;
}

export function cashTitle(set: PackFigureSet, scale: MoneyScale): string {
  const cash = set.current.cash;
  if (set.prior === null) {
    return `Cash stands at ${formatMoney(cash, { scale })}, with no comparative period.`;
  }
  const change = pctChangeClause(cash, set.prior.cash);
  if (change === null) {
    return `Cash stands at ${formatMoney(cash, { scale })}; ${noComparativeBaseSentence('cash', set.prior.cash, true)}`;
  }
  return `Cash is ${change} to ${formatMoney(cash, { scale })}.`;
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
 * Page 4's title. The page itself carries the approved CEO commentary; this
 * is the conclusion above it, and it is derived so that a pack whose
 * commentary is still pending approval still gets a title that says
 * something about the period rather than the word "Commentary" — the exact
 * bare label the rejected pack shipped.
 */
export function narrativeTitle(set: PackFigureSet, scale: MoneyScale): string {
  const { current, prior } = set;
  const level = `Net profit of ${formatMoney(current.netProfit, { scale })}`;
  if (prior === null) return `${level} for the period, with no comparative.`;
  const change = pctChangeClause(current.netProfit, prior.netProfit);
  return change === null
    ? `${level}; ${noComparativeBaseSentence('net profit', prior.netProfit, true)}`
    : `${level}, ${change} on the prior period.`;
}

/**
 * Page 6's title — how the result was EARNED, so it reads the margin and the
 * cost base rather than restating the profit page 5 already led with.
 */
export function incomeStatementTitle(set: PackFigureSet, scale: MoneyScale): string {
  const { current } = set;
  const margin = marginPct(current.revenue - current.costOfSales, current.revenue);
  const costs = `operating expenses of ${formatMoney(current.operatingExpenses, { scale })}`;
  return margin === null
    ? `Revenue of ${formatMoney(current.revenue, { scale })} carries no meaningful margin base against ${costs}.`
    : `Gross margin is ${pctWithWord(margin, 'a positive', 'a negative')}, carrying ${costs}.`;
}

/**
 * Page 10's title. `drawn` and `planned` are stated because spec §4.A asks
 * for six panels and the pack's trend series supports fewer — a title that
 * quietly said "trends" while drawing three of six would hide that from a
 * reader who cannot see what is missing.
 *
 * No scale: every figure in it is a percentage.
 */
export function trendsTitle(trend: PackTrendPoint[], drawn: number, planned: number): string {
  if (trend.length === 0) {
    return `No monthly series covers this period, so 0 of ${planned} panels are drawn.`;
  }
  const first = trend[0]!.revenue;
  const last = trend[trend.length - 1]!.revenue;
  const change = pctChangeClause(last, first);
  // NAMED WINDOW, not a bare percentage. "Revenue is up 1281.4% across 12
  // periods" sat against "Revenue has no positive comparative base for a
  // percentage change" on the highlights and group-results pages — the same
  // measure, two movements, and nothing saying that this one runs from the
  // first MONTH of the series to the last while that one covers the whole
  // period against the comparative. The page's own `Period` disclosure says
  // it in full; the title must not contradict it in the meantime.
  const lead = change === null
    ? `Revenue has no usable base in the first month of the ${trend.length}-month series`
    : `Revenue is ${change} from the first month of the ${trend.length}-month series to the last`;
  return `${lead}; ${drawn} of ${planned} panels are drawn.`;
}

/**
 * Spec §3.5's mandatory negative-equity disclosure, in one place.
 *
 * `NegativeEquityBlock.tsx` renders this and the page model carries it, and a
 * second copy of a MANDATORY disclosure is how the two drift until one of
 * them stops matching what the pack actually shows.
 */
export function negativeEquitySentence(equity: number, scale: MoneyScale): string {
  return `Total equity is ${formatMoney(equity, { scale })}. Liabilities exceed assets by this amount, which may affect covenant compliance and the going-concern assessment.`;
}

/**
 * And the OTHER impossible number on the same sheet.
 *
 * The rendered pack printed total assets of (733). Negative equity got a
 * callout underneath it; negative total assets got nothing, on the same page,
 * from the same balance sheet. It is not a state a business can be in — a
 * balance sheet whose asset side is negative is telling the reader about the
 * ledger rather than about the company — and a sheet that explains the
 * lesser anomaly and stays silent about the greater one reads as though the
 * greater one is normal.
 *
 * It says what it is and what to do about it, and it does NOT restate the
 * figure the table prints three centimetres away in different words.
 */
export function negativeAssetsSentence(assets: number, scale: MoneyScale): string {
  return `Total assets are ${formatMoney(assets, { scale })}. An asset side below zero is not a position a business can hold; it means one or more asset accounts carry credit balances — commonly a bank account overdrawn beyond its recorded facility, or a control account posted against. The balance sheet still foots, so the pack reports it as the ledger states it; it should be traced to the accounts before this pack is relied on.`;
}

/**
 * AND THE THIRD IMPOSSIBLE NUMBER, WHICH GOT NOTHING AT ALL.
 *
 * Brightsphere's pack heads its income statement with revenue of (5 535) and
 * puts the same figure on a highlights tile, with no callout anywhere —
 * while negative ASSETS, two sheets later and no stranger, get a full
 * explanatory block. A pack that explains one anomaly and stays silent about
 * another of the same class reads as though the silent one is normal.
 *
 * Negative turnover is at least as likely to be a posting error as a negative
 * asset side, and it is more consequential: every margin, every ratio with
 * revenue underneath it and the whole scorecard's profitability group are
 * computed off it, and each of them is then reported as not meaningful for a
 * reason the reader has to assemble from footnotes.
 *
 * Same shape as the other two: what it is, what causes it, what it does to
 * the rest of the pack, and that the ledger is reported as it stands.
 */
export function negativeRevenueSentence(revenue: number, scale: MoneyScale): string {
  return `Revenue is ${formatMoney(revenue, { scale })}. Turnover below zero is not a period a business can trade — it means the revenue accounts are in net debit, commonly credit notes or reversals exceeding the period's invoicing, or a receipt posted to an income account the wrong way round. Every margin in this pack divides by revenue, so each of them is reported as not meaningful rather than computed off a negative base. The pack reports the ledger as it stands; the revenue accounts should be traced before it is relied on.`;
}
