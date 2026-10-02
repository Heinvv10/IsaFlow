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
import type { PackChartSpec } from './packChartModel';
import type { PackMatter } from './packMatters';
import type { PackKpiTile, PackStatGroup } from './packKpiTileModel';
import type { PackTable } from './packTableModel';
import type { PackScorecardGroup } from './packScorecardModel';

/** The tile, table and scorecard types split to their own modules at the
 *  300-line cap — `packKpiTileModel.ts`, `packTableModel.ts` and
 *  `packScorecardModel.ts`. Re-exported so no caller moved. */
export type {
  PackKpiDelta,
  PackKpiDeltaAbsence,
  PackKpiTile,
  PackStatItem,
  PackStatGroup,
} from './packKpiTileModel';
export type {
  PackTableColumnKey,
  PackTableRow,
  PackTableColumnNote,
  PackTable,
} from './packTableModel';
export { PACK_TABLE_COLUMN_LABEL } from './packTableModel';
export type {
  PackScorecardStatus,
  PackTrendDirection,
  PackScorecardRow,
  PackScorecardGroup,
} from './packScorecardModel';

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
      /**
       * DRAW THE PANEL UNDER THE PROSE RATHER THAN BESIDE IT.
       *
       * `.pack-narrative-columns` is `2fr 1fr` for an approved narrative and
       * one full-measure column for a pending one, so signing the commentary
       * moved this panel — which comes from the MATTERS and has nothing to do
       * with the commentary — out of 174mm of measure and into 43mm. The live
       * demo company's three derived actions cost 75.1mm at the first and
       * 183.2mm at the second: page 4 needed 288.7mm of a 255mm sheet and the
       * composer refused the whole document, for any non-empty approved
       * commentary, whatever it said. Every fixture carried
       * `commentary: null`, so nothing saw it.
       *
       * Set by `fitPageToBox` and by nothing else — see
       * `stackNarrativeActions`. It is the one lever in the fit that drops
       * NOTHING, which is why it is pulled before any note is taken, and why
       * a page that already fits is never restacked: the side-by-side layout
       * is what page 4 was designed around and it is kept wherever it fits.
       */
      stackActions?: boolean;
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
