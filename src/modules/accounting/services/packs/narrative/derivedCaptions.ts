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
import { formatMoney, formatRatio, inProse, pctWithWord, type MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { SelectedMatters } from '@/modules/accounting/services/packs/pages/packMattersPrinted';
import type {
  PackChartSpec,
  PackKpiDeltaAbsence,
  PackKpiTile,
  PackScorecardGroup,
  PackTableRow,
} from '@/modules/accounting/services/packs/pages/packPageModel';

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

export function scorecardCaption(groups: PackScorecardGroup[]): string {
  const { met, total } = scorecardScore(groups);
  if (total === 0) return scoredTargetsSentence(0, 0);
  const missed = total - met;
  const missedClause = missed > 0 ? `, with ${missed} missed` : '';
  return `${scoredTargetsSentence(met, total)}${missedClause}.`;
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
 * One derived line per highlight tile — spec §4.A page 3's "derived one-liner
 * per tile".
 *
 * It carries no formatted figure on purpose: the tile prints the value itself
 * three centimetres away, and a second rendering of the same number here is
 * how a pack ends up disagreeing with itself over rounding. What the tile
 * cannot say is the DIRECTION's meaning, which is what this adds. That is
 * also why it takes no scale — there is nothing here to scale.
 */
export function tileCaption(tile: PackKpiTile): string {
  if (tile.figure.value === null) {
    return `Not available. ${tile.figure.unavailable ?? ''}`.trim();
  }
  if (tile.delta === null) {
    // REFUSED, NOT DEFAULTED. `PackKpiTile` states that exactly one of `delta`
    // and `deltaAbsence` is non-null, and this used to spell the missing half
    // `?? 'noCurrentValue'` — which prints "This tile has no figure for the
    // period, so there is nothing to move" under a tile that has just printed
    // its figure, because the branch above already returned for a null one.
    // A caption that is false on a board pack is worse than a render that
    // stops, and a fallback is how an invariant stops being one.
    if (tile.deltaAbsence === null) {
      throw new Error(
        `tileCaption: "${tile.label}" shows no movement and states no reason. Exactly one of `
          + 'delta and deltaAbsence must be set; refusing to print a reason this tile did not give.',
      );
    }
    return DELTA_ABSENCE[tile.deltaAbsence];
  }
  const judgement = tile.delta.favourable ? 'a favourable' : 'an unfavourable';
  return `${pctWithWord(tile.delta.value, 'Up', 'Down')} on the ${tile.delta.basis} — ${judgement} movement.`;
}

/**
 * The pack's ONE comparative statement, per reason — see
 * `PackKpiDeltaAbsence`, which is where the reasons are distinguished.
 *
 * Every one of these used to be the first line: "No comparative period, so no
 * movement is shown against this figure.", printed seven times on sheet 3 of
 * a pack whose sheets 5, 6, 7 and 8 carried a prior column and whose sheet 12
 * named the comparative's dates. `unusableBase` is worded in the same terms
 * as `NOT_A_POSITIVE_BASE`, the statement tables' own n/m footnote, so a tile
 * and the table two sheets later say one thing about one figure.
 *
 * A `Record` keyed by the union, so adding a reason is a compile error here
 * rather than a tile that silently prints the wrong one — which is the defect
 * this replaces.
 */
export const NOT_A_POSITIVE_BASE =
  'The prior figure is not a positive base, so no percentage change is meaningful.';

const DELTA_ABSENCE: Record<PackKpiDeltaAbsence, string> = {
  noComparativePeriod: 'No comparative period, so no movement is shown against this figure.',
  noPriorValue: 'The comparative period carries no value for this measure, so no movement is shown.',
  unusableBase: NOT_A_POSITIVE_BASE,
  noCurrentValue: 'This figure is not available for the period, so there is no movement to show.',
};

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
      + `— a current ratio of ${formatRatio(currentAssets / currentLiabilities)}`;
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
    ? 'No operating cash flow figure was captured for this period.'
    : `Operating activities ${ocf >= 0 ? 'generated' : 'consumed'} ${inProse(formatMoney(Math.abs(ocf), { scale }))}.`;
  if (residual === null || residual === 0) return lead;
  return `${lead} ${inProse(formatMoney(Math.abs(residual), { scale }))} of the movement in cash is NOT explained by the operating, investing and financing figures the pack captures; the bridge shows it as an unexplained movement rather than closing the gap silently.`;
}

/**
 * Spec §4.A page 4's narrow column: the action items the board is being asked
 * to decide, derived from the same matters model page 11 tabulates.
 *
 * WHY THE PANEL EXISTS AT ALL. Page 4 was being built as a commentary-only
 * page, so where no human had approved commentary it printed one italic line
 * — 1.0% fill on a sheet of its own, which spec §5.7 says does not ship. §4.A
 * specifies TWO columns, and the second one was simply never populated. With
 * it filled the page carries real content whether or not commentary is
 * approved, so the pack stays twelve pages either way (R-P57) instead of
 * changing shape according to an editorial state.
 *
 * ONE BULLET PER MATTER, drawn from the SELECTION page 11 prints — not from
 * the full matters list. The panel used to take its five from
 * `buildMatters`'s own ranking, so it named JE-2026-00002 as a top matter on
 * sheet 4 and sheet 11 did not list it anywhere: two pages, both claiming to
 * be "derived from the same checks", disagreeing about what the board's
 * action list is. Every bullet here is now a row a director can turn to.
 * What a board needs from this panel is WHICH matters are in front of it,
 * not a summary of them.
 *
 * THE DECISION IS STATED ONCE WHERE IT IS THE SAME FOR ALL OF THEM.
 * `buildMatters` gives every unusual journal the same `decisionRequired`, so
 * a bullet reading "<issue> — <decision>" per matter is the same sentence
 * five times, which is the repetition already undone in the matters table
 * itself. Where the decisions differ, each bullet carries its own.
 *
 * NO PAGE NUMBER IN THE OVERFLOW LINES. They name the matters page in words:
 * page numbers come from position now, and a literal here is the class of
 * cross-reference that sent a reader to the scorecard for the basis of
 * preparation.
 *
 * PROSE, NOT FIGURES. §4.A keeps page 4 free of tabular figures; a bulleted
 * list of decisions is prose, and nothing here formats a rand amount.
 */
const BOARD_ACTIONS_SHOWN = 5;

/**
 * And a LINE budget beside the count, for the same reason page 11 has one.
 *
 * Five is the right number of decisions to put in front of a board; it is not
 * a statement about how much paper five of them take. `buildMatters` embeds
 * `String(error)` in a failed-source matter, so a company whose debtor check
 * is timing out produces five bullets of two hundred characters each and page
 * 4 measured 318mm against a 255mm sheet — the twelve-sheet contract broken
 * from the commentary page rather than from the matters page. The overflow
 * line below already exists to carry whatever does not fit.
 *
 * Both numbers are measured off the printed sheet rather than derived: at
 * ~46 characters a line the panel came out 22.5mm past the paper, and the
 * fixture's own bullets put the column at about 27. The budget is what is
 * left of a 255mm box under the page header and beside the commentary
 * column. `packSheetCount.test.ts`'s long-null-quantum fixture is what holds
 * both honest.
 */
const BOARD_ACTION_CHARS_PER_LINE = 27;
const BOARD_ACTIONS_LINE_BUDGET = 30;

/** As many of the first `BOARD_ACTIONS_SHOWN` matters as the panel can print.
 *  At least one: a panel that lists nothing and says "5 further matters
 *  follow" is the silent omission the panel exists to prevent. */
function actionsThatFit(matters: PackMatter[]): PackMatter[] {
  const fits: PackMatter[] = [];
  let lines = 0;
  for (const matter of matters.slice(0, BOARD_ACTIONS_SHOWN)) {
    // The bullet is at most `issue — decisionRequired`; measured at its
    // longest so the budget holds whichever branch below is taken.
    const cost = Math.ceil(
      (matter.issue.length + matter.decisionRequired.length + 3) / BOARD_ACTION_CHARS_PER_LINE,
    );
    if (fits.length > 0 && lines + cost > BOARD_ACTIONS_LINE_BUDGET) break;
    fits.push(matter);
    lines += cost;
  }
  return fits;
}

/**
 * AN EM DASH JOINS A PHRASE TO A CLAUSE. IT DOES NOT FOLLOW A FULL STOP.
 *
 * Most matters state their issue as a noun phrase — "29 unreconciled bank
 * items across 3 bank accounts" — and `issue — decision` reads as one line.
 * The credit-month matter is three sentences of prose and ends in a full
 * stop, so the panel printed "…the month's revenue and other income of 39. —
 * Identify the reversals…", which is a punctuation mark that means nothing
 * after a sentence has already ended.
 *
 * The matters TABLE has the same two shapes in its Issue column and does not
 * hit this, because it puts the decision in its own column; only the panel
 * runs the two together.
 */
export function joinDecision(issue: string, decision: string): string {
  return /[.!?]$/.test(issue) ? `${issue} ${decision}` : `${issue} — ${decision}`;
}

/**
 * THE MATTERS THIS PAGE ACTUALLY PRINTS — one derivation, two readers.
 *
 * The panel below and page 4's TITLE both have to be about the same set. Page
 * 4 titled itself "Net profit of (1 544) for the period." — a value already
 * headlined on pages 3 and 6, on a sheet whose payload is a panel of board
 * decisions — and the tenth visual gate failed criteria 1, 9 and 15 on it.
 * Titling it by its payload means counting the payload, and a second count
 * derived from `selection.printed` would be the page-4-versus-page-11
 * disagreement `checkMattersCrossReference` exists to refuse, one page over.
 */
export function boardActionMatters(selection: SelectedMatters): PackMatter[] {
  return actionsThatFit(selection.printed);
}

export function boardActionItems(selection: SelectedMatters): string[] {
  const { printed, omitted } = selection;
  if (printed.length === 0) return [];

  const shown = boardActionMatters(selection);
  const decisions = new Set(shown.map((m) => m.decisionRequired));
  const uniform = shown.length > 1 && decisions.size === 1;

  const items = shown.map((matter) =>
    uniform ? matter.issue : joinDecision(matter.issue, matter.decisionRequired),
  );

  if (uniform) {
    items.push(`Each of these needs the same decision: ${shown[0]!.decisionRequired} (${shown[0]!.owner}).`);
  }

  // BOTH remainders, and both are read off the SAME selection page 11
  // prints from — never recomputed from the full list. The panel used to say
  // "23 further matters follow on the matters page" while that page listed
  // six and disclosed twenty-two that follow nowhere: two derivations of one
  // quantity, in the governance section, disagreeing two sheets apart.
  const alsoOnPage = printed.length - shown.length;
  if (alsoOnPage > 0) {
    items.push(`${alsoOnPage} further ${alsoOnPage === 1 ? 'matter follows' : 'matters follow'} on the matters page.`);
  }
  if (omitted.length > 0) {
    items.push(`${omitted.length} further ${omitted.length === 1 ? 'matter is' : 'matters are'} not printed in this pack; the matters page states what they come to.`);
  }
  return items;
}
