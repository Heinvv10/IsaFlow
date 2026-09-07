/**
 * The BLOCK types — everything that can sit on a board-pack page, from a
 * footnote to a matters table.
 *
 * Split from `packPageModel.ts` at the 300-line cap, along the seam the file
 * already read in two halves: this is what a page is MADE OF, and that file
 * is what a page and a document ARE. `packChartModel.ts` split off the chart
 * shapes for the same reason and is imported here. `packPageModel.ts`
 * re-exports every name below, so no caller moved.
 *
 * Every field a page component reads must exist on one of these types — a
 * component may never compute a figure, so if a value belongs on a page, it
 * belongs here first. `PackFigure` (money/pct/ratio/days, with a `source` and
 * an `unavailable` reason) is the one figure shape; nothing here redefines it.
 */

import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { TrustedChartSvg } from '@/lib/charts/ssrSvg';
import type { PackChartSpec } from './packChartModel';
import type { PackMatter } from './packMatters';

/** A footnote referenced from a page's body, numbered within that page. */
export interface PackFootnote {
  number: number;
  text: string;
}

/** A movement beside a figure. The basis is mandatory — "up 12% against
 *  what?" is the failure this type exists to stop; a delta with no stated
 *  comparison basis is not renderable. */
export interface PackKpiDelta {
  value: number;
  /** e.g. 'prior period', 'budget' — what `value` is measured against. */
  basis: string;
  favourable: boolean;
}

export interface PackKpiTile {
  label: string;
  figure: PackFigure;
  delta: PackKpiDelta | null;
  /** Index into the page's `footnotes`, or null when the trend needs none. */
  trendFootnote: number | null;
  /** Pre-rendered sparkline markup, or null when there is no series to show. */
  sparklineSvg: TrustedChartSvg | null;
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

/** The columns a pack table may carry. Stated once per table, in `columns`. */
export type PackTableColumnKey =
  | 'actual'
  | 'prior'
  | 'change'
  | 'changePct'
  | 'pctOfRevenue'
  | 'budget'
  | 'variance';

export interface PackTableRow {
  label: string;
  /** 0-2. Indentation carries hierarchy — a sub-account nests under its
   *  section without restating the section name on every row. */
  level: 0 | 1 | 2;
  role: 'line' | 'subtotal' | 'total' | 'grandTotal';
  /** One figure per column this row has a value for — a subtotal row may
   *  carry only `actual` and `prior`, never a synthesised `change`. */
  figures: Partial<Record<PackTableColumnKey, PackFigure>>;
}

export interface PackTable {
  /** Stated once, in the header — e.g. "R'000" — never repeated per cell. */
  scale: string;
  columns: readonly PackTableColumnKey[];
  rows: PackTableRow[];
}

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

export interface PackNarrative {
  status: 'approved' | 'derived' | 'pending' | 'draft';
  /** A component renders this ONLY when `status` is 'approved' (a human
   *  signed it off) or 'derived' (deterministic code, and LABELLED as such
   *  on the page so the two cannot be mistaken for one another — R7). An
   *  unapproved narrative must not leak into a board pack. */
  body: string | null;
  actions: string[];
}

export interface PackDisclosureNote {
  heading: string;
  body: string;
  footnote?: number;
}

export interface PackDisclosure {
  heading: string;
  notes: PackDisclosureNote[];
}

/** One line of the IFRS-to-adjusted-measure bridge, each with its own figure
 *  — 'IFRS net profit', 'Add back: restructuring costs', 'Adjusted net
 *  profit'. Prose cannot carry this. */
export interface PackReconciliationStep {
  label: string;
  figure: PackFigure;
}

export interface PackDefinition {
  term: string;
  definition: string;
  /** Required by spec §4.A whenever `term` names a non-IFRS measure — §7.1
   *  criterion 12 fails a pack where an adjusted measure has no bridge on
   *  the page or in a footnote. Absent for a definition of a plain IFRS term
   *  with nothing to reconcile. */
  reconciliation?: PackReconciliationStep[];
}

/**
 * A matter as the PAGE carries it.
 *
 * `buildMatters` produces a raw rand `quantum`, because it assembles an
 * exposure out of four reports rather than reading a ledger balance. But it
 * is a FIGURE, printed in a money column beside statements in the same
 * document, and §7.2's first bullet admits no exception: every figure on
 * every page resolves through the provenance map. It was the one printed
 * number in the pack that did not, so the gate's own first rule was not
 * literally true of page 11 (I-4).
 */
export interface PackMatterFigure extends Omit<PackMatter, 'quantum'> {
  /** Null-valued with a reason for a matter that has no single amount — an
   *  overdue filing, or the "no matters" item. Never a zero, which would say
   *  the exposure was measured and found to be nothing. */
  quantum: PackFigure;
}

export type PackPageBlock =
  | { kind: 'kpiTiles'; tiles: PackKpiTile[] }
  | { kind: 'statTiles'; groups: PackStatGroup[] }
  | { kind: 'table'; table: PackTable }
  | { kind: 'scorecard'; groups: PackScorecardGroup[] }
  | { kind: 'chart'; chart: PackChartSpec }
  | { kind: 'smallMultiples'; panels: PackChartSpec[] }
  | {
      kind: 'narrative';
      narrative: PackNarrative;
      /**
       * Spec §4.A page 4's NARROW column — the decisions the board is being
       * asked to take, derived from the matters model (`boardActionItems`).
       *
       * Separate from `PackNarrative.actions`, and it has to be: those are
       * the approver's own action items and these are machine-derived, so
       * one list holding both would be a panel a reader cannot attribute.
       * They render in different columns and each is labelled with where it
       * came from — R7's approved/derived split, applied to a bullet list.
       */
      boardActions?: string[];
    }
  // Spec §4.A page 11 is a TABLE — issue, quantum, owner, movement, decision
  // — and `PackTable`'s column keys are financial (actual/prior/change/…),
  // so a matter cannot be expressed as one. `PackMatter` already carries
  // exactly those five fields; a second shape would be one more thing to
  // keep in step with `buildMatters`.
  | {
      kind: 'matters';
      /** The matters the page has room to print — see `selectPrintedMatters`. */
      matters: PackMatterFigure[];
      /**
       * The matters that did NOT fit, as a count and a total exposure, or
       * null when every one of them is printed.
       *
       * Carried on the block rather than left to the component, because a
       * board pack that prints ten of twenty-eight matters and says nothing
       * has hidden eighteen decisions a director is accountable for. It is
       * DATA so the integrity gate can see it, for the same reason a
       * waterfall carries its bars.
       */
      omitted: { count: number; quantum: PackFigure } | null;
    }
  | { kind: 'disclosure'; disclosure: PackDisclosure }
  | { kind: 'definitions'; entries: PackDefinition[] };
