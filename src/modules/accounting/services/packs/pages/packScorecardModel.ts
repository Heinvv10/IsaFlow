/**
 * The SCORECARD types — page 9's rows, their status and trend, and the
 * lettered groups they sit in. Split from `packBlockModel.ts` at the 300-line
 * cap; that file re-exports every name below, so no caller moved.
 */
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { TrustedChartSvg } from '@/lib/charts/ssrSvg';

export type PackScorecardStatus = 'met' | 'missed' | 'notMeaningful' | 'unscored';

/** Spec §4.A page 9's own Trend column — distinct from Status and from
 *  `bulletSvg` (an actual-vs-target gauge, a different visual). Read from
 *  the service that computed it; never derived from `actual` vs `prior`. */
export type PackTrendDirection = 'up' | 'down' | 'flat';

export interface PackScorecardRow {
  metric: string;
  actual: PackFigure;
  /** Raw target, not a PackFigure — a target is a fixed goal, not a value
   *  read from the ledger, so it carries no `source` to trace. */
  target: number | null;
  prior: PackFigure | null; // Null when there is no prior period (R-P42) — an absent comparative, never a zero.
  status: PackScorecardStatus;
  trend: PackTrendDirection | null; // Null when there's no series to compute a direction from (R-P43) — consistent with trendSvg below, also nullable.
  /** Pre-rendered trend sparkline/arrow markup, null if none beyond `trend`. */
  trendSvg: TrustedChartSvg | null;
  /** Index into the page's `footnotes`. */
  footnote?: number;
  /** Pre-rendered bullet-chart markup, or null when the metric has none. */
  bulletSvg: TrustedChartSvg | null;
}

/** One lettered group of scorecard rows — e.g. "A. Growth". */
export interface PackScorecardGroup {
  letter: string;
  name: string;
  rows: PackScorecardRow[];
}
