/**
 * The board pack's TREND charts — page 10's small multiples and page 8's
 * closing-cash line — split out of `packPageCharts.ts`, which was at the
 * 300-line cap when the profit bridge gained its residual step.
 *
 * The split follows the shape of the work rather than the line count: a
 * BRIDGE asserts arithmetic between two endpoints and is what the integrity
 * gate walks; a TREND draws a level over time and asserts nothing that can be
 * footed. Nothing below changed in the move. `packPageCharts.ts` re-exports
 * every name here, so existing import paths still resolve.
 */

import { formatMoney, inProse, inScale, MONEY_SCALES, type MoneyScale } from '@/lib/format/money';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { creditMonthClause, dominantPoint, moneyPanelScales, type ScaleDominator } from './packTrendScale';
import { monthLabel } from './packPartialMonth';
import type { PackChartSpec } from './packPageModel';
import { MONEY_PANELS, RATIO_PANELS } from './packTrendPanelSet';
import { printedRange, printedSharePct, printedShrinkPct, printedSpan } from './packTrendPrintedFigures';
import { moneyPanel, ratioPanel, ratioTerminal } from './packTrendPanelCharts';

export { TRENDS_PANELS_SPECIFIED } from './packTrendPanelSet';
export { buildCashTrendChart, shorterCashTrendChart } from './packCashTrendChart';

/**
 * Page 10's panels, and what the page has to SAY about the scale they are
 * drawn on.
 *
 * One decision, made here and reported, rather than two: `packPageBlocks`
 * writes the page's scale note off this result instead of recomputing which
 * panels share a domain. The note used to be a fixed sentence naming four
 * money panels, which was false on any pack that drew fewer.
 */
export interface TrendPanels {
  panels: PackChartSpec[];
  /** Money panels drawn on the shared y-domain, by name, in draw order. */
  sharedScale: string[];
  /** Money panels moved to their own domain, with the share of the shared
   *  range each occupies. */
  ownScale: Array<{ name: string; sharePct: number }>;
  /** Panels in a unit of their own — a percentage, a day count. */
  ownUnits: string[];
  /**
   * Ratio panels whose LAST plotted month is the part month, by name.
   *
   * A tag says WHICH month a figure belongs to; it does not say that a RATIO
   * taken over seven of thirty days is an artefact of the window rather than
   * a movement in the business. Page 10 quoted "Gross margin fell from
   * 5323.5% to 100.0% in Sep 2026 (part)" — seven days of revenue against no
   * cost of sales yet posted — and "Debtor days rose from 19 days to 60 days
   * in Sep 2026 (part)", a seven-day ratio annualised over a whole month.
   * Both carried the marker and a director still reads 100.0% as a
   * turnaround. The money panels do not have this problem: a part month's
   * REVENUE is a smaller true figure, while a part month's MARGIN is a
   * different measurement.
   *
   * Named rather than counted, and read off the months each panel actually
   * PLOTTED — a ratio panel drops the months it cannot measure, so the point
   * it ends on is not always the end of the window.
   */
  ratiosEndingOnPartMonth: string[];
  /**
   * Drawn panels that plot FEWER months than the window, by name.
   *
   * `ratioPanel` drops the months it cannot measure rather than plotting a
   * false zero, which is right and was unstated: two of the live demo pack's
   * six panels — gross margin and debtor days — run Jul 2026 to Sep 2026
   * (part) and say "over 3 periods" in their own titles, because revenue is
   * nil before July and neither ratio is defined without it. Page 5 then
   * claimed the twelve-month window "is the series page 10 draws", which the
   * two shortened panels disprove three centimetres away.
   *
   * Brightsphere carries the OMISSION rule already ("A panel is omitted when
   * its figure is not meaningful in every period of the window") and all four
   * of its drawn panels are twelve periods, so its copy of that sentence was
   * true — which is why fourteen gates read it and only the fifteenth put the
   * two packs side by side. The two behaviours are one rule once both halves
   * are stated: omit where the measure exists nowhere in the window, shorten
   * where it exists in part of it.
   *
   * Named rather than counted, because the disclosure names them.
   */
  shortenedPanels: string[];
  /**
   * The shared y-domain in words — "(707) to 1 908, a span of 2 615" — so the
   * page can STATE the denominator its percentages are taken against.
   *
   * Two panels claimed "1.1% of the shared range" and "1.7%" and the page
   * printed nothing a reader could check them against; a reviewer took the
   * spans off the two figures in each panel's own title (2 to 29, 15 to 41),
   * got near-identical numbers, and reported the claims as irreconcilable.
   * They are not — the percentage is the span of a panel's own AXIS, whose
   * two ends the panel prints, over the shared span, not the movement
   * between its first and last month — but
   * a claim a reader cannot check is a disclosure failure whether or not the
   * arithmetic is right.
   *
   * Null where no money panel is drawn.
   */
  sharedRange: string | null;
}

export function buildTrendPanels(trend: PackTrendPoint[], scale: MoneyScale): TrendPanels {
  if (trend.length === 0) {
    return {
      panels: [], sharedScale: [], ownScale: [], ownUnits: [],
      ratiosEndingOnPartMonth: [], shortenedPanels: [], sharedRange: null,
    };
  }

  // ONE y-domain across the money panels (spec §4.A page 10) for every panel
  // that can be read against it. Per-panel autoscaling would draw a flat
  // metric and a collapsing one with the same apparent slope, which is a
  // chart that misreports direction — so a panel only leaves the shared
  // domain when its own range is too small to register on it, and it says so
  // when it does. See `packTrendScale.ts`.
  const series = MONEY_PANELS.map((panel) => trend.map(panel.pick));
  const { shared, panels: rawScales } = moneyPanelScales(series);
  const dominator: ScaleDominator | null = dominantPoint(series);

  // EVERY PERCENTAGE THIS PAGE PRINTS IS THE ONE THE PRINTED FIGURES GIVE —
  // see `atScale`. The domains, and which panel sits on which, are untouched.
  const sharedSpan = printedSpan(shared, scale);
  const scales = rawScales.map((panelScale) => ({
    ...panelScale,
    ownSharePct: printedSharePct(panelScale.domain, sharedSpan, scale),
  }));

  const money = MONEY_PANELS.map((panel, i) => {
    const carriesDominator = dominator !== null && dominator.seriesIndex === i;
    const point = carriesDominator ? trend[dominator.pointIndex] : undefined;
    return moneyPanel(panel, trend, scale, scales[i]!, point === undefined || dominator === null
      ? null
      : {
        // Marked, like every other month this pack names — the scale-setting
        // month can be the stub.
        label: monthLabel(point),
        value: dominator.value,
        // THE PRINTED PERCENTAGE OFF THE PRINTED FIGURES, exactly as
        // `printedSharePct` does for a panel's own share — see `atScale`. The
        // reader subtracts the two ranges the sheet prints; the number beside
        // them has to be the one that subtraction gives.
        sharePct: printedShrinkPct(sharedSpan, dominator.residual, scale),
        residualRange: printedRange(dominator.residual, scale),
        creditMonth: creditMonthClause(point),
      });
  });

  // Spec order: revenue, gross margin %, operating expenses, net profit,
  // cash, debtor days.
  const panels: PackChartSpec[] = [
    money[0]!,
    ratioPanel(RATIO_PANELS[0]!, trend, scale),
    money[1]!,
    money[2]!,
    money[3]!,
    ratioPanel(RATIO_PANELS[1]!, trend, scale),
  ].filter((p): p is PackChartSpec => p !== null);

  return {
    panels,
    sharedScale: MONEY_PANELS.filter((_, i) => scales[i]!.shared).map((p) => p.name),
    ownScale: MONEY_PANELS
      .map((p, i) => ({ name: p.name, sharePct: scales[i]!.ownSharePct, shared: scales[i]!.shared }))
      .filter((p) => !p.shared)
      .map(({ name, sharePct }) => ({ name, sharePct })),
    ownUnits: RATIO_PANELS.filter((p) => panels.some((drawn) => drawn.id === p.id)).map((p) => p.name),
    ratiosEndingOnPartMonth: RATIO_PANELS
      .filter((p) => panels.some((drawn) => drawn.id === p.id))
      .filter((p) => ratioTerminal(p, trend)?.partial === true)
      .map((p) => p.name),
    // Only the ratio panels can shorten: a money panel plots every month of
    // the window by construction, because a month with nothing posted is a
    // true nil rather than an unmeasurable one. Counted off the same `pick`
    // the panel itself draws from, so the list cannot disagree with the
    // titles that say "over N periods".
    shortenedPanels: RATIO_PANELS
      .filter((p) => panels.some((drawn) => drawn.id === p.id))
      .filter((p) => trend.filter((point) => p.pick(point) !== null).length < trend.length)
      .map((p) => p.name),
    // The span is the difference of the two extremes AS PRINTED, so the
    // subtraction a reader does on the sheet gives the number the sheet
    // states. `shared.max - shared.min` rounded separately does not: the
    // live demo page published "1 908", "(1 621)" and "a span of 3 528".
    // AND THE UNIT IN THE FORM PROSE STATES ONE IN — see `inScale`. It read
    // "a span of 3 529 R'000", the column banner shoved against a figure,
    // which is a third position for a unit the pack otherwise only ever
    // sets above the column it governs.
    sharedRange: `${inProse(formatMoney(shared.min, { scale }))} to `
      + `${inProse(formatMoney(shared.max, { scale }))}, a span of `
      + `${inScale(inProse(formatMoney(sharedSpan * MONEY_SCALES[scale], { scale })), scale)}`,
  };
}
