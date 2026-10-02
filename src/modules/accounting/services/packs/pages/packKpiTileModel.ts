/**
 * The TILE types — page 3's KPI tile with its movement and sparkline, and
 * the small grouped stats. Split from `packBlockModel.ts` at the 300-line
 * cap; that file re-exports every name below, so no caller moved.
 */
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { TrustedChartSvg } from '@/lib/charts/ssrSvg';

/** A movement beside a figure. The basis is mandatory — "up 12% against
 *  what?" is the failure this type exists to stop; a delta with no stated
 *  comparison basis is not renderable. */
export interface PackKpiDelta {
  value: number;
  /**
   * What `value` is counted in. `percent` is a relative change — revenue up
   * 12.0% on the prior period. `points` is the difference of two PERCENTAGES:
   * a margin of 30% that becomes 33% moved 3.0 points, and printing its
   * relative change ("up 10.0%") tells a board the margin rose by ten.
   * Rendered through `deltaWithWord`, by the tile and by its caption alike.
   */
  unit: 'percent' | 'points';
  /** e.g. 'prior period', 'budget' — what `value` is measured against. */
  basis: string;
  favourable: boolean;
}

/**
 * WHY a tile shows no movement — required whenever `delta` is null, because
 * the four reasons are not the same statement and the pack printed the
 * strongest of them for all four.
 *
 * Every tile on the live demo pack read "No comparative period, so no
 * movement is shown against this figure." while four statement pages printed
 * a prior column and page 12 named the comparative's dates. The comparative
 * existed; what did not exist was a usable percentage BASE — prior revenue of
 * nil, prior net profit of (905). One null on `delta` was carrying all of
 * "there is no prior period", "this measure has no prior value" and "the
 * prior figure is not a base a percentage can be taken off", and the caption
 * had no way to tell them apart.
 *
 * `unusableBase` is worded on the page in the same terms as the statement
 * tables' own n/m footnote, so the tile and the table under it say one thing.
 */
export type PackKpiDeltaAbsence =
  /** `PackFigureSet.prior` is null — a first-period company (R3). */
  | 'noComparativePeriod'
  /** A comparative period exists, but this measure has no value in it. */
  | 'noPriorValue'
  /** Both figures exist; the prior one is not a positive base, so `marginPct`
   *  refuses a percentage change off it. */
  | 'unusableBase'
  /** The tile's own figure is unavailable, so there is nothing to move. The
   *  tile prints `figure.unavailable` instead of a movement. */
  | 'noCurrentValue';

export interface PackKpiTile {
  label: string;
  figure: PackFigure;
  delta: PackKpiDelta | null;
  /** Exactly one of `delta` and `deltaAbsence` is non-null. */
  deltaAbsence: PackKpiDeltaAbsence | null;
  /** Index into the page's `footnotes`, or null when the trend needs none. */
  trendFootnote: number | null;
  /** Pre-rendered sparkline markup, or null when there is no series to show. */
  sparklineSvg: TrustedChartSvg | null;
  /**
   * THE MONTHS THE SPARKLINE ACTUALLY PLOTS, against the months the window
   * holds — null where there is no sparkline.
   *
   * Two of page 3's lines cover a third of the window the others cover: gross
   * margin and debtor days have no meaningful figure in a month with no
   * revenue, so those months are dropped rather than drawn as a false zero,
   * and on the live demo company that is nine of twelve. Drawn to the same
   * width, side by side, with nothing saying so, the short ones read as the
   * same window at a different shape. The pack states this everywhere else it
   * happens — page 4's `PANEL_OMITTED_RULE`, page 10's "over N periods"
   * titles — and `tileCaption` is page 3's version of that sentence.
   */
  sparklineWindow: { plotted: number; of: number } | null;
  /**
   * THE Y-DOMAIN THE SPARKLINE IS DRAWN ON, and whether other tiles are drawn
   * on it too — null where there is no sparkline.
   *
   * Every line used to be normalised to its own tile, which is the one scale
   * on the sheet the page never stated. A rand swing of 37 and a rand swing of
   * 2 692 came out 313 px and 303 px tall in one row, and on Brightsphere the
   * smaller swing was drawn the deeper. The money lines share a domain now,
   * exactly as page 10's money panels do; a series in another unit — a
   * percentage, a day count — cannot join a rand domain, so it keeps its own
   * and `sharedScaleClause` says which is which.
   *
   * Carried on the TILE rather than derived at the page, because the page's
   * sentence and the picture must come from one reading: a footnote that
   * recomputes the domain is a second answer to "what was drawn".
   */
  sparklineScale: {
    min: number;
    max: number;
    shared: boolean;
    /**
     * WHAT UNIT THOSE TWO NUMBERS ARE IN.
     *
     * Page 3's footnote states the shared money domain and, for a line that
     * cannot join it, has to state that line's own — and `(1 621) to 1 908`
     * is not how a percentage or a day count is written. The unit travels
     * with the domain rather than being inferred from the tile's label,
     * because a label is prose and this is what the axis was drawn in. Page
     * 10 prints both ends of these same two measures (`5323.5%`,
     * `60 days`); this is page 3's half of the same convention.
     */
    unit: 'money' | 'percentage' | 'days';
  } | null;
}

export interface PackStatItem {
  label: string;
  figure: PackFigure;
}

/** One grouped block of small stats — page 12's key-statistics strip. */
export interface PackStatGroup {
  heading: string;
  stats: PackStatItem[];
}

