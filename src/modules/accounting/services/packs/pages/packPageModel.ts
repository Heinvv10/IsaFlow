/**
 * The typed model for a 12-page board pack.
 *
 * Every field a page component reads must exist on this file's types — a
 * component may never compute a figure, so if a value belongs on a page, it
 * belongs here first. `PackFigure` (money/pct/ratio/days, with a `source` and
 * an `unavailable` reason) is the one figure shape; nothing here redefines it.
 *
 * `assertPageTitleIsAMessage` is the cheap guard, not the judge. The pack was
 * rejected for titles like 'Financial Ratios' and 'KPI Scorecard' — bare
 * labels, not conclusions about the period — and the real judge of whether a
 * title reads as a message is the visual gate applied to the rendered page.
 * This function only catches the exact failure class the rejected pack shipped.
 */

import { PackFigureProvenance, type PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';
import type { PackBrand } from '@/modules/accounting/services/packs/packBrand';
import type { TrustedChartSvg } from '@/lib/charts/ssrSvg';

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
  sparklineSvg: string | null;
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
  prior: PackFigure;
  status: PackScorecardStatus;
  trend: PackTrendDirection;
  /** Pre-rendered trend sparkline/arrow markup, null if none beyond `trend`. */
  trendSvg: string | null;
  /** Index into the page's `footnotes`. */
  footnote?: number;
  /** Pre-rendered bullet-chart markup, or null when the metric has none. */
  bulletSvg: string | null;
}

/** One lettered group of scorecard rows — e.g. "A. Growth". */
export interface PackScorecardGroup {
  letter: string;
  name: string;
  rows: PackScorecardRow[];
}

/** One bar of a waterfall chart, carried as data so the integrity gate can
 *  check that the bars actually sum to their endpoints without re-parsing
 *  the rendered SVG. */
export interface PackWaterfallBar {
  label: string;
  start: number;
  end: number;
  kind: 'open' | 'increase' | 'decrease' | 'close';
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
}

export interface PackNarrative {
  status: 'approved' | 'pending' | 'draft';
  /** A component renders this ONLY when `status === 'approved'` — an
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

export type PackPageBlock =
  | { kind: 'kpiTiles'; tiles: PackKpiTile[] }
  | { kind: 'statTiles'; groups: PackStatGroup[] }
  | { kind: 'table'; table: PackTable }
  | { kind: 'scorecard'; groups: PackScorecardGroup[] }
  | { kind: 'chart'; chart: PackChartSpec }
  | { kind: 'smallMultiples'; panels: PackChartSpec[] }
  | { kind: 'narrative'; narrative: PackNarrative }
  | { kind: 'disclosure'; disclosure: PackDisclosure }
  | { kind: 'definitions'; entries: PackDefinition[] };

export interface PackPage {
  /** 1-based, matches spec §4's page numbers. */
  number: number;
  /** A conclusion about this period, never a bare label. Enforced by test. */
  title: string;
  section: 'Performance' | 'Financials' | 'Governance' | 'Front';
  orientation: 'portrait' | 'landscape';
  density: 'low' | 'medium' | 'high';
  blocks: PackPageBlock[];
  footnotes: PackFootnote[];
}

/** Spec §7.1 criterion 8's ONE number convention for the whole pack.
 *  `PackTable.scale` still states its own scale in its header (§5.5 — a
 *  table must read alone), but this is the authority a later gate checks
 *  every table's `scale` against, so R'000 and R cannot both pass silently.
 *  Currency lives here, not again on `PackBasisOfPreparation`. */
export interface PackNumberConvention {
  /** e.g. "R'000". */
  scale: string;
  /** e.g. 'ZAR'. */
  currency: string;
}

/** Spec §4.A page 12's basis-of-preparation metadata — standard, source
 *  system, extract timestamp, and the ledger version rendered against, i.e.
 *  the traceability anchor for reproducing this render. (`period` and
 *  `numberConvention.currency` already cover those two, so not repeated.) */
export interface PackBasisOfPreparation {
  /** e.g. 'IFRS for SMEs'. */
  standard: string;
  /** e.g. 'IsaFlow general ledger'. */
  sourceSystem: string;
  /** When the ledger was read to build this pack. */
  extractedAt: string;
  /** Which ledger state the pack was rendered against. */
  ledgerVersion: string;
}

export interface PackPagesDocument {
  packType: PackType;
  packLabel: string;
  companyName: string;
  period: string;
  generatedAt: string;
  draft: boolean;
  brand: PackBrand;
  numberConvention: PackNumberConvention;
  basisOfPreparation: PackBasisOfPreparation;
  /** Every figure issued while building the twelve pages, so a later task can
   *  call `doc.provenance.assertConsistent()` against the whole document
   *  rather than one page at a time. */
  provenance: PackFigureProvenance;
  pages: PackPage[];
}

/**
 * Page titles that are navigation, not a conclusion about the period, and so
 * are exempt from the message rule by exact match. Page 1's title (the
 * company's legal name) is exempt separately, by page NUMBER — see below.
 */
const EXEMPT_NAVIGATION_TITLES = new Set([
  'Contents',
  'Basis of preparation and definitions',
  'Matters requiring board attention',
]);

/** A verb of movement — the heuristic's other admission besides a digit. */
const MOVEMENT_VERBS = [
  'up', 'down', 'widened', 'narrowed', 'met', 'missed', 'improved', 'fell', 'rose', 'held',
];

/**
 * Reject a bare label in place of a title that states a conclusion.
 *
 * This is a heuristic, deliberately: it allows a title through when it
 * contains a digit or one of a small set of movement verbs, and rejects it
 * otherwise. Its job is to fail the exact class of title the rejected pack
 * shipped ('Financial Ratios', 'Commentary', 'KPI Scorecard') — it cannot
 * judge whether an admitted title is actually a good conclusion. That
 * judgement is the visual gate's, applied to the rendered page, not this
 * function's.
 */
export function assertPageTitleIsAMessage(title: string, pageNumber: number): void {
  // Page 1's title is the company's legal name — arbitrary data we do not
  // choose, exempt by page number rather than by matching its text.
  if (pageNumber === 1) return;
  if (EXEMPT_NAVIGATION_TITLES.has(title)) return;

  const hasDigit = /\d/.test(title);
  const lower = title.toLowerCase();
  const hasMovementVerb = MOVEMENT_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(lower));

  if (!hasDigit && !hasMovementVerb) {
    throw new Error(
      `Page ${pageNumber} title '${title}' is a bare label, not a conclusion ` +
        `about the period. A title must contain a digit or one of: ` +
        `${MOVEMENT_VERBS.join(', ')}. This is a cheap guard in front of the ` +
        `real judge, which is the visual gate applied to the rendered page.`,
    );
  }
}

/**
 * Whether a page number falls under the "content page" density rule.
 *
 * The cover (1) and contents (2) are excluded — neither carries the tables
 * and scorecards the density rule governs.
 */
export function isContentPage(pageNumber: number): boolean {
  return pageNumber > 2;
}
