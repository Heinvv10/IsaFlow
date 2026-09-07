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
import { formatMoney, formatPctMagnitude, type MoneyScale } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type {
  PackChartSpec,
  PackKpiTile,
  PackScorecardGroup,
  PackTableRow,
} from '@/modules/accounting/services/packs/pages/packPageModel';

export function scorecardCaption(groups: PackScorecardGroup[]): string {
  const { met, total } = scorecardScore(groups);
  if (total === 0) {
    return 'No scorecard metric has a target to score against this period.';
  }
  const missed = total - met;
  const missedClause = missed > 0 ? `, with ${missed} missed` : '';
  return `${met} of ${total} scored targets were met this period${missedClause}.`;
}

export function largestMoverCaption(rows: PackTableRow[]): string {
  const movers = rows
    .filter((r) => r.role === 'line')
    .map((r) => ({ label: r.label, pct: r.figures.changePct?.value ?? null }))
    .filter((m): m is { label: string; pct: number } => m.pct !== null && Number.isFinite(m.pct));

  if (movers.length === 0) {
    return 'No line item shows a meaningful period-on-period movement.';
  }

  const largest = movers.reduce((a, b) => (Math.abs(b.pct) > Math.abs(a.pct) ? b : a));
  const direction = largest.pct >= 0 ? 'up' : 'down';
  return `${largest.label} moved the most, ${direction} ${formatPctMagnitude(largest.pct)}.`;
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
  const noun = panels.length === 1 ? 'metric is' : 'metrics are';
  return `${panels.length} ${noun} tracked over the period; each panel states where it started and where it ended.`;
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
    return 'No comparative period, so no movement is shown against this figure.';
  }
  const direction = tile.delta.value >= 0 ? 'Up' : 'Down';
  const judgement = tile.delta.favourable ? 'a favourable' : 'an unfavourable';
  return `${direction} ${formatPctMagnitude(tile.delta.value)} on the ${tile.delta.basis} — ${judgement} movement.`;
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
  const coverClause = cover === null
    ? 'Current liabilities are not a positive base, so no cover percentage is meaningful'
    : `Current assets cover current liabilities ${formatPctMagnitude(cover)}`;
  return `${coverClause}; working capital stands at ${formatMoney(workingCapital, { scale })}.`;
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
    : `Operating activities ${ocf >= 0 ? 'generated' : 'consumed'} ${formatMoney(Math.abs(ocf), { scale })}.`;
  if (residual === null || residual === 0) return lead;
  return `${lead} ${formatMoney(Math.abs(residual), { scale })} of the movement in cash is NOT explained by the operating, investing and financing figures the pack captures; the bridge shows it as an unexplained movement rather than closing the gap silently.`;
}
