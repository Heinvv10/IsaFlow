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
  /**
   * A footnote `fitPageToBox` may not take.
   *
   * Same distinction `PackDisclosure.required` draws, for the same reason.
   * The fitter pops footnotes last-first, and on the live Brightsphere income
   * statement the last two were the prior-column basis and the SIGN-FLIP note
   * — the one that explains why the table states operating expenses as
   * (3 717) while the bridge below it draws `3 717`. Without it the page
   * shows a chart apparently contradicting the table on the same sheet, with
   * nothing offered to reconcile them; the page fitted and said "Not printed
   * on this page: 2 footnotes", which is not an answer a director has.
   *
   * Marked on the notes that explain a printed FIGURE rather than the ones
   * that qualify the page, so the fitter still has levers.
   */
  required?: true;
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
  sparklineScale: { min: number; max: number; shared: boolean } | null;
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

/**
 * The columns a pack table may carry. Stated once per table, in `columns`.
 *
 * TWO FAMILIES, AND A TABLE USES ONE OF THEM. The first seven are the
 * COMPARATIVE columns — one measure per row, read across periods. The five
 * below them are MEASURE columns, for a table whose rows are periods rather
 * than lines: page 5's month-by-month results. A table mixing the two would
 * be claiming a row is both a line and a month.
 */
export type PackTableColumnKey =
  | 'actual'
  | 'prior'
  | 'change'
  | 'changePct'
  | 'pctOfRevenue'
  | 'budget'
  | 'variance'
  | 'revenue'
  | 'otherIncome'
  | 'costOfSales'
  | 'monthOperatingExpenses'
  | 'otherExpenses'
  | 'netProfit';

export interface PackTableRow {
  label: string;
  /**
   * The row's stable identity — `is.revenue`, `bs.currentAssets` — as the
   * table's own builder names it.
   *
   * Carried because a page has to classify rows without reading their prose:
   * page 6's sign check asks which lines are INCOME and which are COST, and a
   * classification driven by a regex over labels is one rewording away from
   * putting operating profit in the cost band. Absent on a table whose
   * builder does not name its rows.
   */
  key?: string;
  /** 0-2. Indentation carries hierarchy — a sub-account nests under its
   *  section without restating the section name on every row. */
  level: 0 | 1 | 2;
  role: 'line' | 'subtotal' | 'total' | 'grandTotal';
  /** One figure per column this row has a value for — a subtotal row may
   *  carry only `actual` and `prior`, never a synthesised `change`. */
  figures: Partial<Record<PackTableColumnKey, PackFigure>>;
  /**
   * Index into the page's numbered `footnotes`, where one is ABOUT this row.
   *
   * The pack ran two footnote systems and only the lettered one worked. The
   * `n/m` marks have always pointed at their reasons; the NUMBERED footnotes
   * at the foot of pages 5 to 9 pointed at nothing — twelve of them on the
   * demo pack, every one unanchored, including "Opening cash in the table
   * above is the balance at the START of the reporting period" printed under
   * a table whose Opening cash row carried no marker. A numbered note with no
   * superscript is a promise the page does not keep, and it is the same
   * defect the pack twice fixed by DELETING an orphan footnote.
   *
   * Same shape and name as `PackScorecardRow.footnote`, which page 9 has
   * always used correctly, so there is one convention rather than two.
   */
  footnote?: number;
}

/**
 * The header each column prints, in the pack's own words.
 *
 * On the MODEL rather than in `ComparativeTable`, where it was: the rendered
 * text layer is checked against these strings (`packTextLayer.ts`), and a gate
 * that keeps its own copy of the labels is a gate that passes a table printing
 * something else.
 */
/** A numbered footnote anchored to a column heading — see
 *  `PackTable.columnNotes`. */
export interface PackTableColumnNote {
  column: PackTableColumnKey;
  footnote: number;
}

export const PACK_TABLE_COLUMN_LABEL: Record<PackTableColumnKey, string> = {
  actual: 'Actual',
  prior: 'Prior',
  change: 'Change',
  changePct: 'Change %',
  pctOfRevenue: '% of Revenue',
  budget: 'Budget',
  variance: 'Variance',
  revenue: 'Revenue',
  otherIncome: 'Other income',
  costOfSales: 'Cost of sales',
  // SHORT, because a column heading is set in 7pt letter-spaced caps over a
  // 26mm measure and `TABLE_HEAD_MM` budgets ONE line for it. "Operating
  // expenses" takes two there; "Operating" does not, and the row it heads is
  // named in full in the page's own note.
  monthOperatingExpenses: 'Operating',
  otherExpenses: 'Other',
  netProfit: 'Net profit',
};

export interface PackTable {
  /** Stated once, in the header — e.g. "R'000" — never repeated per cell. */
  scale: string;
  columns: readonly PackTableColumnKey[];
  rows: PackTableRow[];
  /**
   * Numbered footnotes anchored to a COLUMN HEADER rather than to a row.
   *
   * "The prior column is the period 26 April 2025 to 31 December 2025 — 250
   * days" is a statement about a column, and there is no row to hang it on:
   * it qualifies every cell under one heading. Anchoring it to the heading is
   * what the sentence already claims in words, and it is the only one of the
   * numbered footnotes whose subject is not a row or a note.
   */
  columnNotes?: readonly PackTableColumnNote[];
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
  /**
   * Set on a disclosure whose notes are a LIST rather than an argument —
   * page 12's seven basis-of-preparation facts, each a label and a value.
   *
   * Set across the full 174mm measure they cost 62mm of a 255mm sheet, most
   * of it white space to the right of "Standard IFRS for SMEs"; in two
   * columns they cost half that, and the page has a sixteen-term glossary to
   * fit beneath them. Landscape pages already column their disclosures
   * unconditionally (`packPrint.css`); this is the same treatment, asked for
   * rather than inferred from the paper.
   */
  columns?: 2;
  /**
   * True where the pack is not free to leave this note off the page.
   *
   * §3.5's negative-equity consequence, the negative-assets note beside it,
   * the unexplained-plug sentence the integrity gate demands whenever a
   * bridge foots on a step nothing measured, and every "why this chart is
   * not here" explanation — an empty result is never an empty page, read in
   * the other direction.
   *
   * `fitPageToBox` reads it: a page short of paper takes the pack's optional
   * prose first and reaches these last, and never takes a required
   * disclosure's first note, which would leave the heading standing over a
   * disclosure that was not made.
   */
  required?: boolean;
}

/** One line of the IFRS-to-adjusted-measure bridge, each with its own figure
 *  — 'IFRS net profit', 'Add back: restructuring costs', 'Adjusted net
 *  profit'. Prose cannot carry this. */
export interface PackReconciliationStep {
  label: string;
  figure: PackFigure;
  /**
   * THE SAME LINE FOR THE COMPARATIVE PERIOD, where the pack has one.
   *
   * Page 5 stated the comparative EBITDA — "The comparative period's is
   * (905)" — with the same prominence as the current one, and nothing in the
   * pack reconciled it. It happened to equal comparative operating profit
   * exactly, which a reader cannot tell from an add-back the pack failed to
   * compute; §7.1 criterion 12 fails a non-IFRS measure stated without its
   * bridge, and it does not exempt the column a pack states second.
   *
   * Absent where `PackFigureSet.prior` is null: a first-period company has no
   * comparative to bridge, and an empty second column would claim one.
   */
  comparative?: PackFigure;
}

export interface PackDefinition {
  term: string;
  definition: string;
  /** Required by spec §4.A whenever `term` names a non-IFRS measure — §7.1
   *  criterion 12 fails a pack where an adjusted measure has no bridge on
   *  the page or in a footnote. Absent for a definition of a plain IFRS term
   *  with nothing to reconcile. */
  reconciliation?: PackReconciliationStep[];
  /**
   * Why the bridge above does not add as PRINTED — set only when it does not.
   *
   * A reconciliation is the one table in a pack whose job is to add, and page
   * 12 printed `(1 545) + 77 = (1 467)` where the printed operands give
   * 1 468. Every figure is right: the steps are unrounded rands and the page
   * rounds each of them to the nearest R'000 independently, so the sum of the
   * roundings differs from the rounding of the sum by up to half a unit. The
   * page carries a general rounding note in the same column, so the
   * arithmetic is derivable — and "derivable" is the wrong standard for a
   * three-line non-IFRS bridge a director is invited to foot. It says so on
   * the line, in the figures it actually printed.
   */
  reconciliationNote?: string;
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
  | {
      kind: 'scorecard';
      groups: PackScorecardGroup[];
      /**
       * The page footnote its PRIOR headings point at, or null where the
       * pack has no comparative period.
       *
       * The scorecard's five lettered groups are five `<table>`s of one grid,
       * so PRIOR is printed five times; pages 6, 7 and 8 marked their single
       * one and this sheet marked none. Carried on the BLOCK rather than per
       * group — it is one column of one grid and one note.
       */
      priorFootnote?: number | null;
    }
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
      /**
       * The COUNTS below that panel — "1 further matter follows on the
       * matters page", "27 further matters are not printed in this pack".
       *
       * Separate because they are statements ABOUT the list rather than
       * members of it: set as list items they read as two more decisions, and
       * a director scanning a panel of three counts five.
       */
      boardActionsTail?: string[];
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
