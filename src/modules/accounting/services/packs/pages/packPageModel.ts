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

import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';
import type { PackBrand } from '@/modules/accounting/services/packs/packBrand';
import type { MoneyScale } from '@/lib/format/money';
import type { PackPageBlock, PackFootnote } from './packBlockModel';

/** The BLOCK types split to `packBlockModel.ts` for the 300-line cap — what a
 *  page is made of, as against what a page and a document are. Re-exported
 *  because every existing caller imports them from this module. */
export type {
  PackDefinition,
  PackDisclosure,
  PackDisclosureNote,
  PackFootnote,
  PackKpiDelta,
  PackKpiTile,
  PackMatterFigure,
  PackNarrative,
  PackPageBlock,
  PackReconciliationStep,
  PackScorecardGroup,
  PackScorecardRow,
  PackScorecardStatus,
  PackStatGroup,
  PackStatItem,
  PackTable,
  PackTableColumnKey,
  PackTableRow,
  PackTrendDirection,
} from './packBlockModel';

export interface PackPage {
  /** 1-based, matches spec §4's page numbers. */
  number: number;
  /** A conclusion about this period, never a bare label. Enforced by test. */
  title: string;
  /**
   * The short name this page goes by in the CONTENTS — "Income statement",
   * "Cash", "Matters".
   *
   * Distinct from `title`, and it has to be. `title` is a conclusion by rule
   * (`assertPageTitleIsAMessage`), so the contents page listed whole
   * sentences: entry 4 read "Net profit of (1 545 540); the comparative
   * profit base is measured against a negative comparative base, so the
   * percentage change is not meaningful." An index a director scans to find
   * the balance sheet cannot be built out of the pack's own commentary.
   */
  navLabel: string;
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
  /**
   * e.g. "R'000". Typed `MoneyScale`, not `string`: EVERY figure the pack
   * prints — cell, tile, prose sentence, chart axis, bar label — is formatted
   * at this scale, and a value no formatter recognises would print rands
   * under a header claiming thousands. That is the 1000x misread R-P52
   * exists to stop, so it is made unrepresentable rather than validated at
   * each of the dozen render sites. `adoptPackPagesDocument` re-narrows it on
   * the far side of the JSON boundary, where the type guarantee does not
   * survive.
   */
  scale: MoneyScale;
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

/**
 * The comparative period, as a claim and as a fact.
 *
 * `label` is what a reader sees under the prior column and on page 12; `start`
 * and `end` are the window those figures were actually read over, copied from
 * `PackFigureSet.priorWindow`. Both, because they fail DIFFERENTLY: a
 * provenance check proves the cells came from prior-period readings and can
 * still be satisfied by a document that heads them with the wrong dates, and
 * right data under a wrong label is a lie the reader has no way to see. The
 * integrity gate re-derives `label` from the window and refuses a pack where
 * the two have drifted apart (R-P55).
 *
 * `null` on the document means there is NO comparative — a first-period
 * company (R3: an absent comparative is an absent column, never zeros). A pack
 * whose statements show a prior column while this is null, or which states a
 * period no statement compares against, is refused either way.
 */
export interface PackComparativePeriod {
  /** e.g. '1 September 2025 to 28 February 2026' — `formatPackPeriod`'s words. */
  label: string;
  /** ISO date, inclusive. */
  start: string;
  /** ISO date, inclusive. */
  end: string;
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
  /** The period the prior column compares against, or null where there is
   *  none. See `PackComparativePeriod` — it is both the printed claim and the
   *  window behind it, so the gate can tell them apart. */
  comparativePeriod: PackComparativePeriod | null;
  /** Every figure issued while building the twelve pages, so a later task can
   *  call `doc.provenance.assertConsistent()` against the whole document
   *  rather than one page at a time. */
  provenance: PackFigureProvenance;
  pages: PackPage[];
}

/** The page-level rules, moved to a sibling so this file could stay under the
 *  300-line cap while gaining the `matters` block kind. Re-exported here
 *  because every existing caller imports them from this module. */
export { assertPageTitleIsAMessage, isContentPage } from './packPageRules';

/** The chart data types, split to `packChartModel.ts` for the 300-line cap
 *  when `PackWaterfallBar` gained its `uncaptured` flag. Re-exported because
 *  every existing caller imports them from this module. */
export type { PackChartClaim, PackChartSpec, PackWaterfallBar } from './packChartModel';
