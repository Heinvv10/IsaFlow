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
   */
  uncaptured?: boolean;
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
