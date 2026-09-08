/**
 * What a chart carries into a page, as DATA.
 *
 * Split from `packPageModel.ts` for the 300-line cap. It is a clean seam
 * rather than an arbitrary one: everything here exists so a bridge can be
 * CHECKED without re-parsing the rendered SVG — the bars, their kinds, and
 * the flag marking a step nothing measured. `packPageModel.ts` re-exports
 * both names, so every existing import path still resolves.
 */

import type { TrustedChartSvg } from '@/lib/charts/ssrSvg';

/** One bar of a waterfall chart, carried as data so the integrity gate can
 *  check that the bars actually sum to their endpoints without re-parsing
 *  the rendered SVG. */
/**
 * WHY A BRIDGE HAS TO PLUG — one member per bridge, because the two bridges
 * have different gaps and one explanation for both is a false statement on
 * whichever page it was not written for.
 *
 * `cashFlowSplits` — page 8: the figure set carries the period's cash totals
 * and none of the operating/investing/financing detail.
 * `belowTheOperatingLine` — page 6: interest and tax sit between operating
 * profit and net profit and no field carries them.
 */
export type PlugReason = 'cashFlowSplits' | 'belowTheOperatingLine';

export interface PackWaterfallBar {
  label: string;
  start: number;
  end: number;
  /**
   * 'subtotal' is a MID-statement rest point — Gross Profit, Operating Profit
   * — drawn from the axis rather than from the bar before it, so the chain
   * restarts there (R-P50). The integrity gate checks it by its `end` against
   * what the chain accumulated to, never by its `start`; without the member
   * those bars had to be reported by their drawn direction, which is true of
   * the rectangle and false of the arithmetic, and the gate would have failed
   * an honest bridge.
   */
  kind: 'open' | 'increase' | 'decrease' | 'subtotal' | 'close';
  /**
   * True for a bar drawn only to make the bridge foot — page 8's
   * `Unexplained movement`, page 6's `Other, not separately captured`. It is
   * a flag rather than a `kind` because arithmetically such a bar IS an
   * increase or a decrease and the chain walk must treat it as one; what is
   * different about it is that no service measured it. The proportion check
   * reads this, and a label match would break the moment either bar is
   * re-worded.
   *
   * IT CARRIES THE REASON RATHER THAN `true`, and that is the fix for a
   * sentence that explained an income statement as a cash flow statement.
   * `disproportionatePlugSentence` served both bridges from one string, whose
   * second half said the step "holds everything the operating, investing and
   * financing splits a cash flow statement is made of would have shown" — true
   * of page 8, and told a director to go and ask for the cash flow statement
   * about page 6's bridge, where the plug is interest and tax. With the reason
   * on the bar there is no `true` to mark a plug with, so a new plug cannot be
   * added without saying what is in it.
   */
  uncaptured?: PlugReason;
  /**
   * WHICH INK THE BAR IS ACTUALLY DRAWN IN, carried as data for the same
   * reason `kind` is: the sheet makes a claim about the colour rule in
   * words, and a claim about a drawing has to be checkable against the
   * drawing rather than against a second copy of the rule.
   *
   * It mirrors `stepColour` in `packChartOptions.ts` exactly — favourable
   * ink on an income line, unfavourable on a cost line, whichever way the
   * period ran — and `bridgeSignFootnote` reads it to say, on the page,
   * which of the two the named bar is. Absent on a subtotal, which carries
   * no class of its own and stays actual ink.
   */
  paint?: 'favourable' | 'unfavourable';
}

/**
 * A figure a chart's own TITLE states, carried as data.
 *
 * Page 8 printed closing cash twice — `(532)` in the cash table and `(752)`
 * in the closing-cash line's title — and the integrity gate saw neither,
 * because it walks figures and bars and a chart title is prose. Re-parsing
 * the sentence would be a second, undeclared formatter; this is the claim
 * itself, so the gate compares NUMBERS against the table on the same page.
 *
 * `label` must match the table row it is a claim about, exactly. A claim
 * that matches no row on the page is not checked — a chart may legitimately
 * state something the page tabulates nowhere.
 */
export interface PackChartClaim {
  label: string;
  value: number;
}

export interface PackChartSpec {
  /** Stable id for this chart within its page — how a later task addresses
   *  it (e.g. the integrity gate reporting which chart failed). */
  id: string;
  /** A conclusion, not a category label — same rule as a page title. */
  title: string;
  kind: 'line' | 'bar' | 'waterfall' | 'combo';
  svg: TrustedChartSvg;
  heightMm: number;
  /**
   * The plot box the SVG was RENDERED at, in millimetres — what the
   * stylesheet gives `.pack-chart-svg` so the drawn box and the rendered box
   * are one number. See `packChartBox.ts`.
   *
   * On a full-width chart that is `heightMm` less the caption; on a page-10
   * panel `heightMm` IS the plot box, so the two are equal.
   */
  plotMm: number;
  /**
   * Every bar this bridge did NOT draw, in the order the walk reaches them.
   *
   * TWO RULES DROP A BAR AND BOTH REPORT HERE. A movement line whose figure
   * for the period is nil is not drawn — a bridge used to drop a nil Other
   * Expenses and keep a nil Cost of Sales, so the demo company's page 6 drew
   * six bars and Brightsphere's drew seven off the same statement with
   * nothing on either sheet saying so. And the Operating Profit SUBTOTAL is
   * drawn only where the walk reaches the figure the table states, because a
   * bar that disagreed with the row three centimetres above it would be a
   * second figure for one line.
   *
   * It comes back from `buildProfitWaterfall` with the steps rather than
   * being re-derived from them: the second rule turns on a comparison the
   * caller never makes, and page 6 named five movement lines and could not
   * name the subtotal however it was dropped. `bridgeSignFootnote` gives the
   * two rules a sentence each, because "a line with a nil figure is not
   * drawn: Operating Profit" is false of the subtotal.
   *
   * Empty on a bridge that drew every line, and absent on a chart that is
   * not a bridge.
   */
  omittedBars?: string[];
  /** Populated only when `kind === 'waterfall'`; that is what the bars-sum-
   *  to-endpoints check reads instead of the SVG string. */
  waterfallBars?: PackWaterfallBar[];
  /** The figures this chart's title asserts — see `PackChartClaim`. */
  claims?: PackChartClaim[];
  /**
   * For a page-10 small multiple: whether it is drawn on the money group's
   * SHARED y-domain.
   *
   * Carried as data because the page has to state the split and a test has to
   * be able to prove it off the composed document rather than off a second
   * computation. A panel whose own range is a twentieth or less of the shared
   * one is drawn on its own scale (`packTrendScale.ts`) — the alternative was
   * three panels with a total excursion of one or two pixels — and a reader
   * who cannot tell which is which is being misled about relative magnitude,
   * which is the only reason to draw small multiples together at all.
   *
   * Absent on every chart that is not one of those panels.
   */
  sharedScale?: boolean;
}
