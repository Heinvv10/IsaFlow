/**
 * The pack's derived CAPTIONS — the sentence that sits under a table, a
 * chart or a tile row, as opposed to the page TITLE above it, which lives in
 * `derivedSentences.ts` and is re-exported from there.
 *
 * A sibling rather than more of that file: adding the document's
 * `numberConvention.scale` to every money-bearing builder took it past the
 * repo's 300-line ceiling. The split follows the shape of the work — a title
 * is the page's conclusion and a caption explains one block on it — and
 * `derivedSentences.ts` re-exports every name below, so every existing
 * import path still resolves.
 *
 * SCALE IS REQUIRED WHEREVER A FIGURE IS PRINTED, and required rather than
 * defaulted, for exactly the reason `formatFigureText` made it required
 * (R-P52): the pack's tables print `R'000` and its prose printed rands, so
 * the same figure appeared twice on one page a thousand apart, and the
 * default was the unsafe path. A compile error is the only thing that stops
 * that coming back.
 */

import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { rankedBy, superlativeClause } from './statedRelation';
import { MONEY_TOLERANCE } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { formatMoney, formatTimes, inProse, pctWithWord, type MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type {
  PackChartSpec,
  PackScorecardGroup,
  PackTableRow,
} from '@/modules/accounting/services/packs/pages/packPageModel';

export { deltaWithWord, NOT_A_POSITIVE_BASE, tileCaption } from './derivedTileCaptions';
export { boardActionItems, boardActionMatters, joinDecision } from './derivedBoardActions';
export type { BoardActions } from './derivedBoardActions';

/**
 * The scored-target sentence, WRITTEN ONCE.
 *
 * It was written twice — here and in `scorecardTitle` — and both copies read
 * "0 of 1 scored targets were met this period", which is the page's largest
 * type disagreeing with itself about number. The demo company hides it
 * because it scores three; only a one-target company shows it, and
 * Brightsphere is one. Two copies of a sentence is why one of them can be
 * wrong, so there is one now and both callers use it.
 *
 * The noun and the verb both follow the TOTAL, not the met count: "0 of 1
 * scored target was met" and "1 of 3 scored targets were met" both read as
 * written English, where agreeing the verb with the met count gives "0 of 1
 * scored target were met".
 */
export function scoredTargetsSentence(met: number, total: number): string {
  if (total === 0) return 'No scorecard metric has a target to score against this period.';
  const noun = total === 1 ? 'scored target was' : 'scored targets were';
  return `${met} of ${total} ${noun} met this period`;
}

/**
 * AND IT WAS THE PAGE'S OWN TITLE WITH FOUR WORDS ON THE END.
 *
 * Page 9's heading reads "0 of 3 scored targets were met this period." and
 * its derived commentary read "0 of 3 scored targets were met this period,
 * with 3 missed." — three centimetres apart, on the sheet whose own §5.7 rule
 * says a caption restating the title pads the page with an echo.
 * `positionCaption` cites that rule and obeys it; this one broke it, and the
 * missed count is arithmetic a reader already has from the two numbers above.
 *
 * WHICH GROUPS is what the title cannot say. A director reading "0 of 3" asks
 * where, and the letters are on the sheet: naming them turns a restatement
 * into the one sentence on the page that points somewhere.
 */
export function scorecardCaption(groups: PackScorecardGroup[]): string {
  const { total } = scorecardScore(groups);
  if (total === 0) return scoredTargetsSentence(0, 0);
  // AND THE NOUN FOLLOWS THE MISSES, NOT THE GROUPS THEY FALL IN.
  //
  // "The misses are in Liquidity." printed on a sheet whose title, four
  // centimetres above, singularises correctly — "0 of 1 scored target WAS
  // met". Same page, same count, two verbs: the plural bug this file's own
  // `scoredTargetsSentence` was written for, reappearing in a sentence added
  // one round after that fix. A count is not a length: two misses in one
  // group is still "the misses", and one miss in one group is "the miss".
  const missedRows = groups.reduce((n, g) => n + g.rows.filter((r) => r.status === 'missed').length, 0);
  const missedIn = groups.filter((g) => g.rows.some((r) => r.status === 'missed')).map((g) => g.name);
  if (missedIn.length > 0) {
    const subject = missedRows === 1 ? 'The miss is' : 'The misses are';
    return `${subject} in ${namedInWords(missedIn)}.`;
  }
  const scoredRows = groups.reduce(
    (n, g) => n + g.rows.filter((r) => r.status === 'met' || r.status === 'missed').length, 0,
  );
  const scoredIn = groups
    .filter((g) => g.rows.some((r) => r.status === 'met' || r.status === 'missed'))
    .map((g) => g.name);
  const subject = scoredRows === 1 ? 'The scored target is' : 'The scored targets are';
  return `${subject} in ${namedInWords(scoredIn)}.`;
}

/** "a", "a and b", "a, b and c" — the pack's list voice. */
function namedInWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * "NO LINE ITEM SHOWS A MEANINGFUL MOVEMENT" WAS A CLAIM ABOUT THE PACK, MADE
 * BY A PAGE THAT HAD LOOKED AT ONE ROW.
 *
 * Sheet 5 printed it and sheet 6, the next page, printed "Cost of sales moved
 * the most, up 77.8%." Both came from this function and each was right about
 * its own table — sheet 5's summary carries exactly one `line` row, revenue,
 * whose percentage change is not meaningful because the comparative is not a
 * positive base. What was wrong was the sentence: an absent PERCENTAGE is not
 * an absent MOVEMENT, and saying so put a denial two sheets from its own
 * counter-example.
 *
 * So the empty case says what is actually true — that this page has no
 * comparable movement — and carries the reason the cells already give,
 * rather than concluding something about the period from it.
 *
 * AND THE RANKING IS THE MONEY. It ranked on the percentage column and read
 * "Operating expenses moved the most, up 102.1%." on a table where cost of
 * sales moved 626 against operating expenses' 115 — 626 of the 639 total
 * deterioration. The sentence answered "which line changed most relative to
 * itself" in the words of "which line explains the result", two centimetres
 * under a bridge whose tallest bar is cost of sales. `rankedBy` takes the
 * ranking as a value and `superlativeClause` makes the sentence name the
 * measure; see `statedRelation.ts` for why the percentage is not the honest
 * superlative here.
 */
export function largestMoverCaption(rows: PackTableRow[], scale: MoneyScale): string {
  const lineRows = rows.filter((r) => r.role === 'line');
  // RANKED ON THE MONEY, AND THE SENTENCE SAYS SO — see `rankedBy` and the
  // docblock above `RankedMeasure` for why this page's superlative is the
  // money and not the percentage.
  const largest = rankedBy(lineRows, 'money', (r) => r.figures.change?.value ?? null);

  if (largest === null) {
    // The reason is taken from whichever change column the page HAS, so a
    // table carrying percentages but no amounts still explains itself.
    const reason = lineRows
      .flatMap((r) => [r.figures.change, r.figures.changePct])
      .find((f) => f !== undefined && f.value === null && f.unavailable !== undefined)
      ?.unavailable;
    return reason === undefined
      ? 'No line item on this page carries a period-on-period movement.'
      : `No line item on this page has a comparable movement. ${reason}`;
  }

  // The figure is the one the ranking was TAKEN on — `Superlative.value` —
  // and the percentage is not restated beside it: this caption sits under the
  // table's own Change % column, and the round before this one found a
  // sentence for every figure the same sheet already prints.
  const moved = largest.value;
  return `${largest.winner.label} ${superlativeClause(largest)}, `
    + `${moved < 0 ? 'down' : 'up'} ${formatMoney(Math.abs(moved), { scale })}.`;
}

/**
 * Page 10's caption.
 *
 * It used to concatenate every panel's own TITLE — six full sentences, each
 * of which is already printed above its own panel three centimetres away.
 * On a landscape page whose content box is 168mm tall that block of restated
 * captions was enough to push the page onto a second sheet, and a reader who
 * read it learnt nothing the panels did not already say. It states the count
 * and what the panels are for; each panel still states its own movement.
 */
export function trendsCaption(panels: PackChartSpec[]): string {
  if (panels.length === 0) {
    return 'No trend panels are available this period.';
  }
  // DRAWN, NOT TRACKED — and the two words were the same page's two answers
  // to one question. Brightsphere's sheet 10 read "4 metrics are tracked over
  // the period" above a note reading "A board pack tracks six measures on
  // this page … and 4 of the six could be drawn for this company", so a
  // director met "tracked" twice on one sheet meaning two different counts.
  // The pack TRACKS six; a page DRAWS as many as the ledger supports. One
  // character shorter than the word it replaces.
  const noun = panels.length === 1 ? 'measure is' : 'measures are';
  return `${panels.length} ${noun} drawn over the period; each panel states where it started and where it ended.`;
}

/**
 * How many scorecard targets were met, of those that could be scored.
 *
 * Lives beside `scorecardCaption`, which does the same counting, so page 9's
 * title and its caption cannot disagree about the score — two independent
 * counts of the same rows is exactly how a pack contradicts itself.
 */
export function scorecardScore(groups: PackScorecardGroup[]): { met: number; total: number } {
  const scored = groups
    .flatMap((g) => g.rows)
    .filter((r) => r.status === 'met' || r.status === 'missed');
  return { met: scored.filter((r) => r.status === 'met').length, total: scored.length };
}

/**
 * Page 7's caption. Deliberately NOT `positionTitle`, which is the page's own
 * heading: a commentary block that restates the title pads the page's density
 * with an echo, which is the opposite of what spec §5.7's three-block rule is
 * for. This says what the title does not — how the near-term obligations are
 * covered.
 */
export function positionCaption(set: PackFigureSet, scale: MoneyScale): string {
  const { currentAssets, currentLiabilities } = set.current;
  const workingCapital = currentAssets - currentLiabilities;
  const cover = marginPct(currentAssets, currentLiabilities);
  // ONE MEASURE, AND THE SHEET NAMES THE OTHER SHEET'S UNITS FOR IT.
  //
  // This cover is `currentAssets / currentLiabilities` and so is the CURRENT
  // RATIO the scorecard prints and page 12 defines — the same quotient, one
  // sheet showing it as a percentage and another as a multiple, with nothing
  // saying they are the same number: 13.8% here against (0.14) on page 9 for
  // the demo company, 58.2% against (0.58) for Brightsphere. A director
  // holding the two sheets side by side has two figures for one thing.
  //
  // Both conventions are printed here, once, so the identity is on the page
  // rather than left to a reader to spot. The percentage leads because the
  // sentence is about COVER; the ratio follows because that is what the
  // scorecard and the glossary call it.
  const coverClause = cover === null
    ? 'Current liabilities are not a positive base, so no cover percentage is meaningful'
    : `Current assets cover current liabilities ${pctWithWord(cover, 'at', 'at negative')} `
      + `— a current ratio of ${inProse(formatTimes(currentAssets / currentLiabilities))}`;
  return `${coverClause}; working capital stands at ${inProse(formatMoney(workingCapital, { scale }))}.`;
}

/**
 * Page 8's caption, and the place the cash bridge's plug is explained.
 *
 * `residual` is the movement in cash the three captured categories do not
 * account for. The bridge draws it as a named bar so the chart foots; a
 * reader must be told it is unexplained rather than left to assume it is
 * something we measured.
 */
export function cashCaption(set: PackFigureSet, residual: number | null, scale: MoneyScale): string {
  const ocf = set.current.operatingCashFlow;
  const lead = ocf === undefined
    // The read's own reason where the statement could not be read at all —
    // see `buildCashTable`, whose rows say the same.
    ? set.current.cashFlowUnavailable ?? 'No operating cash flow figure was captured for this period.'
    : `Operating activities ${ocf >= 0 ? 'generated' : 'consumed'} ${inProse(formatMoney(Math.abs(ocf), { scale }))}.`;
  if (residual === null || Math.abs(residual) <= MONEY_TOLERANCE) return lead;
  return `${lead} ${inProse(formatMoney(Math.abs(residual), { scale }))} of the movement in cash is NOT explained by the operating, investing and financing figures the pack captures; the bridge shows it as an unexplained movement rather than closing the gap silently.`;
}
