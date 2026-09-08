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
import { formatMoney, inProse, inScale, pctWithWord, type MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { monthLabel } from '@/modules/accounting/services/packs/pages/packPartialMonth';
import { scoredTargetsSentence } from './derivedCaptions';

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
 * A MONEY FIGURE ON ITS WAY INTO A SENTENCE — always through `inProse`.
 *
 * `formatMoney` prints a measured zero as an en dash, which is right in a
 * money COLUMN and is not a word. Five titles here interpolated it raw, and
 * the consequence was not a dash on paper: `packProseIntegrity`'s zero-glyph
 * rule reads `page.title`, and `assertPackIntegrity` THROWS on a hit — so a
 * company whose net profit, cash or working capital is nil received no pack
 * at all, surfacing as a 422. Reachability is ordinary: a dormant company, a
 * bank account exactly drawn down, current assets equal to current
 * liabilities, or — because the dash covers anything under half a unit of the
 * scale — any of those under five rand at `R'000`.
 *
 * One helper for the whole file rather than eleven `inProse(formatMoney(...))`
 * call sites, because the one that gets forgotten is the eleventh.
 */
function money(n: number, scale: MoneyScale): string {
  return inProse(formatMoney(n, { scale }));
}

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
    : `Operating margin is ${pctWithWord(margin, 'a positive', 'a negative')}.`;

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
      return `Equity is ${change} to ${money(equity, scale)}.`;
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
  return `Cash is ${change} to ${money(cash, scale)}.`;
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
 * Page 4's title — ABOUT THE PAGE'S OWN PAYLOAD.
 *
 * It was `Net profit of ${…} for the period.` on both companies: a value
 * restatement, of a figure already headlined on page 3 and page 6, on a sheet
 * whose payload is the board's commentary beside a panel of decisions the
 * board is being asked to take. The tenth visual gate failed criterion 1 on
 * it in both packs ("the reader is told the net profit … and nothing about
 * the six or seven decisions the page exists to raise"), and cited it again
 * under 15.
 *
 * So it counts what is ON THIS SHEET, against what the pack raises in total,
 * and names the largest of them. Both halves are checkable off the paper: the
 * panel below lists the first number, and page 11's own title carries the
 * second. Scoped explicitly — "N of the M matters" — because page 11 says
 * "29 matters require a board decision" and a bare "3 matters" on the sheet
 * before it reads as a contradiction rather than as a selection.
 *
 * `shown` is the panel's OWN list, from `boardActionMatters`, not
 * `selection.printed`: matters that fit page 11 but not this panel are
 * carried by the panel's "N further matters follow" line and are not on this
 * sheet, so counting them here would title the page after content it does not
 * print — the two-pages-disagreeing defect one page over.
 */
export function narrativeTitle(
  shown: PackMatter[],
  raised: number,
  scale: MoneyScale,
): string {
  if (raised === 0) {
    return '0 matters require a board decision this period; this page carries the commentary on it.';
  }
  const scope = `${shown.length} of ${raised} matters requiring a board decision `
    + `${shown.length === 1 ? 'is' : 'are'} put to the board on this page`;
  const quantified = shown.filter((m) => m.quantum !== null);
  if (quantified.length === 0) {
    return `${scope}; none of them carries a single rand amount.`;
  }
  const largest = quantified.reduce((a, b) => (Math.abs(b.quantum!) > Math.abs(a.quantum!) ? b : a));
  // ONE PLACEMENT FOR THE UNIT, and it is page 11's. This sentence put the
  // scale clause INSIDE the phrase — "the largest carrying 1 869, in R'000 of
  // exposure" — while page 11, the facing sheet, wrote "27 of them carrying
  // 3 544 of exposure, in R'000". The same clause, two positions, on adjacent
  // pages, in the largest type either page sets: that is what reads as a
  // slot-filled string rather than as written prose. `inScale` takes the
  // WHOLE phrase, so the unit ends the sentence in both places.
  return `${scope}, the largest carrying ${inScale(`${money(largest.quantum!, scale)} of exposure`, scale)}.`;
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
    : `Gross margin is ${pctWithWord(margin, 'a positive', 'a negative')} on revenue of `
      + `${money(current.revenue, scale)}.`;
}

/**
 * Page 10's title — WHAT THE SERIES DID, not how many panels the renderer
 * managed to draw.
 *
 * It ended "; 6 of 6 panels are drawn." (4 of 6 on Brightsphere). A count of
 * rendered panels is a rendering status: it belongs in a log, and on a sheet
 * going to non-executive directors it is the single line in this pack that
 * most obviously shows the machine. The count is not dropped — it moves to
 * the disclosure apparatus that already carries it: the page's caption opens
 * "6 metrics are tracked over the period", and where a measure is MISSING
 * the mandatory `Panels not drawn` block names how many could be drawn,
 * which of the six they are, and why.
 *
 * AND THE OTHER HALF WAS A CAVEAT WHERE A FINDING BELONGS. Where the first
 * month gives no usable base the lead read "Revenue has no usable base in
 * the first month of the 12-month series" — an explanation of a denominator
 * as a headline. The series still DID something over those months, and
 * saying so is both a finding and true: it runs from its first month's
 * figure to its last, which is the page's own first-to-last convention.
 *
 * No scale for the percentage branch; the level branch takes one, because
 * the two figures it prints are money.
 */
export function trendsTitle(
  trend: PackTrendPoint[],
  scale: MoneyScale,
  /** How many measures this page tracks. Read ONLY by the empty-series
   *  branch, which has no figure of its own to state. */
  planned: number,
): string {
  if (trend.length === 0) {
    return `No monthly series covers this period, so none of the ${planned} measures `
      + 'this page tracks is drawn month by month.';
  }
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  const change = pctChangeClause(last.revenue, first.revenue);
  // NAMED WINDOW, not a bare percentage. "Revenue is up 1281.4% across 12
  // periods" sat against "Revenue has no positive comparative base for a
  // percentage change" on the highlights and group-results pages — the same
  // measure, two movements, and nothing saying that this one runs from the
  // first MONTH of the series to the last while that one covers the whole
  // period against the comparative. The page's own `Period` disclosure says
  // it in full; the title must not contradict it in the meantime.
  if (change !== null) {
    return `Revenue is ${change} from the first month of the ${trend.length}-month series to the last.`;
  }
  // The terminal month is NAMED, and marked where it is a stub — the same
  // marking every panel's own movement sentence carries, so a headline
  // quoting a seven-day month cannot read as a full one.
  if (first.revenue !== last.revenue) {
    return `Revenue runs from ${money(first.revenue, scale)} in ${monthLabel(first)} `
      + `to ${money(last.revenue, scale)} in ${monthLabel(last)}, `
      + `across the ${trend.length}-month series.`;
  }
  // ENDS THE SAME AS IT STARTED IS NOT "NOTHING HAPPENED", and on the one
  // company where this branch fires it is emphatically not: Brightsphere's
  // revenue is nil in the first month and nil in the last and (5 535) in
  // April, so "runs from nil to nil" would be a headline that hides the only
  // thing on the page worth reading. First-to-last is the page's convention
  // and it is the wrong sentence when the two are equal; the extreme is what
  // the series did.
  const extreme = trend.reduce((far, point) =>
    Math.abs(point.revenue - first.revenue) > Math.abs(far.revenue - first.revenue) ? point : far, first);
  if (extreme.revenue === first.revenue) {
    return `Revenue is ${money(first.revenue, scale)} in every month of the ${trend.length}-month series.`;
  }
  return `Revenue is ${money(first.revenue, scale)} in both the first and last of the ${trend.length} months, `
    + `and ${money(extreme.revenue, scale)} at its furthest, in ${monthLabel(extreme)}.`;
}


/**
 * Spec §3.5's mandatory negative-equity disclosure, in one place.
 *
 * `NegativeEquityBlock.tsx` renders this and the page model carries it, and a
 * second copy of a MANDATORY disclosure is how the two drift until one of
 * them stops matching what the pack actually shows.
 */
export function negativeEquitySentence(equity: number, scale: MoneyScale): string {
  return `Total equity is ${money(equity, scale)}. Liabilities exceed assets by this amount, which may affect covenant compliance and the going-concern assessment.`;
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
/**
 * AND IT WAS THE REVENUE LINE ONLY, ON A SHEET WITH FOUR OF THEM.
 *
 * The same asymmetry the balance sheet's check had, one page earlier.
 * Brightsphere's income statement prints revenue of (5 535) under a headed
 * block AND operating expenses of (3 717), other expenses of (411) and other
 * income of (1) with no comment at all — three more lines the wrong side of
 * zero, on the sheet the block is about. They reach the pack's matters page
 * as "months whose expenses are a net credit", eleven sheets later, with
 * nothing on page 6 pointing there.
 *
 * So the check runs over every income and cost line the page prints, the way
 * `impossibleBalancesSentence` runs over every asset and liability row.
 * Subtotals are not in it: a negative gross profit, operating profit or net
 * profit is a real result a real business can post, and folding those in
 * would tell a director that a loss is a posting error.
 *
 * THE TWO SIDES HAVE DIFFERENT CAUSES and are stated separately, because an
 * income account in net debit and a cost account in net credit are different
 * postings to go looking for.
 */
export type ImpossibleIncomeSide = 'income' | 'cost' | 'both';

const IMPOSSIBLE_INCOME_CAUSE: Record<ImpossibleIncomeSide, string> = {
  income: 'income accounts in net debit, from credit notes or reversals exceeding the period\'s '
    + 'invoicing, or a receipt posted to an income account the wrong way round',
  cost: 'cost accounts in net credit, from a reversal or a refund exceeding the period\'s charges, '
    + 'or a payment posted to an expense account the wrong way round',
  // The arm the live Brightsphere pack takes, and the one the sheet has least
  // room for: naming four lines instead of one already costs page 6 a line of
  // 9.5pt it does not have, and the sheet composes at 258.4mm in a 255mm box
  // if this runs to the length of the two above. What went is the
  // restatement, not a cause a reader has to go looking for.
  both: 'income accounts in net debit and cost accounts in net credit — a reversal, a refund or a '
    + 'posting made the wrong way round',
};

/**
 * The consequence clause, which belongs to REVENUE and to nothing else: it is
 * the denominator of every margin in the pack. Naming it against a negative
 * other-income line would be a statement about a figure nothing divides by.
 */
const NEGATIVE_REVENUE_CONSEQUENCE =
  ' Every margin divides by revenue, so each is reported as not meaningful rather than computed '
  + 'off a negative base.';

export function impossibleIncomeLinesSentence(
  lines: ReadonlyArray<{ label: string; amount: number }>,
  side: ImpossibleIncomeSide,
  scale: MoneyScale,
  /** Whether REVENUE is one of the lines below zero — see the constant above. */
  revenueIsOne: boolean,
): string {
  const named = lines.map((line, i) => {
    // Sentence case on the first, lower on the rest, so the list reads as one
    // sentence rather than as four run together — `impossibleBalancesSentence`
    // does the same with its own rows.
    const label = i === 0 ? line.label : line.label.toLowerCase();
    return `${label} ${money(line.amount, scale)}`;
  });
  const list = named.length === 1
    ? named[0]!
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;
  return `${list} ${lines.length === 1 ? 'is' : 'are'} below zero: ${IMPOSSIBLE_INCOME_CAUSE[side]}.`
    + `${revenueIsOne ? NEGATIVE_REVENUE_CONSEQUENCE : ''}`
    + ' The ledger is reported as it stands; trace these accounts before relying on this sheet.';
}

/**
 * AND THE FOURTH IMPOSSIBLE NUMBER, WHICH IS A COMPONENT RATHER THAN A TOTAL.
 *
 * Brightsphere's balance sheet prints non-current liabilities of (424) — a
 * NEGATIVE LIABILITY — and says nothing, on a sheet that devotes a titled
 * block to negative total assets and another to negative equity. The pack
 * treats a sign impossibility as worth explaining when it lands on a total
 * and as unremarkable when it lands on a line, and a reader cannot tell that
 * apart from the pack having decided the line is fine.
 *
 * It is the same class and the same remedy: a liability below zero means one
 * or more accounts in that band carry debit balances, which is a
 * classification or a posting question rather than a fact about what the
 * company owes. Stated at the same length and in the same shape as the other
 * three — what it is, what causes it, and that the ledger is reported as it
 * stands — so a reader meeting any of the four gets the same treatment.
 *
 * NAMED, because "a liability" would not say which. Page 7 prints two
 * liability lines and a total; this sentence is built for whichever of them
 * is below zero and states that row's own label.
 */
export type ImpossibleSide = 'assets' | 'liabilities' | 'both';

/**
 * WHY THE BALANCE CANNOT BE WHAT IT SAYS, one clause per side.
 *
 * A `Record` over the union rather than a chain of `if`s — the
 * `CREDIT_MONTH_STANDING` device — so the case a fixture never reaches is one
 * the author still had to write a sentence for. The `both` arm is not the
 * other two concatenated: an asset carrying credits and a liability carrying
 * debits are the same KIND of error and a reader who is told it twice reads
 * two problems.
 */
const IMPOSSIBLE_CAUSE: Record<ImpossibleSide, string> = {
  assets: 'An asset below zero is not a balance a business can hold: it means one or more '
    + 'accounts classified as assets carry credit balances.',
  liabilities: 'A liability below zero is not an amount that can be owed: it means one or more '
    + 'accounts classified as liabilities carry debit balances.',
  both: 'Neither figure is a balance that can be held as stated: it means one or more accounts '
    + 'carry balances contrary to the band they are classified in.',
};

/**
 * THE SIGN CHECK, RUN ON EVERY LINE OF THE BALANCE SHEET RATHER THAN ON TWO
 * OF THEM.
 *
 * The pack checked TOTAL assets and — after the round before this one —
 * COMPONENT liabilities, and nothing else. The asymmetry did exactly what an
 * asymmetry does: Brightsphere's page 7 printed `Non-current liabilities
 * (424)` with a headed block explaining it and `Current assets (3 372)`
 * three rows above with no comment at all, because that pack's total assets
 * are POSITIVE and the asset check only ever looked at the total. The one
 * line that fell through was the largest number it could have fallen
 * through on, on the sheet a director reads for solvency.
 *
 * So the check is over every asset and liability row the page prints,
 * component and total, both sides. Equity is deliberately NOT in it: negative
 * equity is a real position a real business can hold, and it has its own
 * §3.5 disclosure two blocks down.
 *
 * ONE NOTE, NAMING EVERY OFFENDING LINE. Page 7 composes at 253.07mm of 255
 * on BOTH companies — 1.93mm, less than half a line — so a note per line, or
 * a block per side, is paper the sheet does not have on either pack. The
 * lines are listed in one sentence and the cause follows once.
 */
export function impossibleBalancesSentence(
  lines: ReadonlyArray<{ label: string; amount: number }>,
  side: ImpossibleSide,
  scale: MoneyScale,
): string {
  const named = lines.map((l, i) => {
    // The first names its measure in full; the rest are figures under it, so
    // the sentence reads as a list rather than as three sentences run
    // together.
    const label = i === 0 ? `${l.label} are` : l.label.toLowerCase();
    return `${label} ${money(l.amount, scale)}`;
  });
  const list = named.length === 1
    ? named[0]!
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;
  return `${list}. ${IMPOSSIBLE_CAUSE[side]} That is a classification or a posting question `
    + 'rather than a smaller figure, and the pack reports the ledger as it stands: the balances '
    + 'should be resolved before this sheet is relied on.';
}
