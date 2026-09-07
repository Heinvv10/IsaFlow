/**
 * Page 12 — basis of preparation and definitions.
 *
 * What makes every number on the other eleven pages auditable: the standard
 * applied, the source system, when the ledger was read, and which ledger
 * state the pack was rendered against. Spec §7.1 criterion 12 fails a pack
 * where a non-IFRS measure has no reconciliation bridge. The pack prints ONE
 * — EBITDA — and `packDefinitions.ts` builds it as figures, line by line,
 * against the same sources page 5's table prints. Every other measure on this
 * page is a ratio or a formula with nothing to bridge from.
 *
 * `ledgerVersion` is the traceability anchor a reader could use to reproduce
 * this exact render. This function is deliberately synchronous — the model
 * composes, it does not fetch — so the ledger version is not read here; it
 * is a VALUE the caller supplies (R-P46). The intended source is
 * `getLedgerPostedThrough` in `postedThroughService`, called once by
 * whichever task assembles page 12 alongside the rest of the pack.
 *
 * `set.budget.postedThrough` was tried and rejected as a substitute: it is
 * `null` for any company with no budget (Brightsphere, and others), and even
 * when present it answers "when was the budget variance last posted
 * through", not "what ledger state did THIS pack render against" — a
 * different question. A `null` ledgerVersion parameter renders the explicit
 * text below rather than falling back to a proxy or to `doc.generatedAt` —
 * an invented audit identifier on the one page whose purpose is auditability
 * would be the worst of the three options.
 */

import type {
  PackBasisOfPreparation,
  PackComparativePeriod,
  PackFootnote,
  PackDefinition,
  PackNumberConvention,
  PackPagesDocument,
} from './packPageModel';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { formatPackTimestamp } from './packPeriodLabel';
import { draftStatusSentence, type PackDraftReason } from './packDraftStatus';
import { buildDefinitions } from './packDefinitions';
import { NO_INVENTORY_CLASSIFIED } from './packScorecard';
import type { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { MoneyScale } from '@/lib/format/money';
import { partialMonthBasisNote, partialMonthOf } from './packPartialMonth';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

export interface PackBasis {
  basisOfPreparation: PackBasisOfPreparation;
  numberConvention: PackNumberConvention;
  definitions: PackDefinition[];
  /** The part-month sentence page 12's Period line carries, or null where the
   *  series ends on a whole month — see `partialMonthBasisNote`. */
  partialMonth: string | null;
  /** `classificationCaveat` off the current figures, this pack's own wording
   *  of the inventory caveat (see `INVENTORY_CAVEAT`), and the draft status
   *  when `doc.draft`. Surfaced rather than suppressed — see
   *  `reportPackDataService.ts` for what each condition means. */
  caveats: string[];
}

/**
 * A CAVEAT MUST QUALIFY SOMETHING THE PACK PRINTS.
 *
 * `inventoryCaveat` off `reportPackDataService` carries `inventoryWarning`'s
 * `board` wording, which is written for a report that PUBLISHES a quick
 * (acid-test) ratio: "the quick ratio does not exclude it … read it as a
 * current ratio". This pack publishes no quick ratio — the scorecard's
 * liquidity metric is the current ratio — so page 12 was qualifying a measure
 * that appears nowhere in the document, which is a sentence about nothing.
 *
 * The underlying FACT is real and worth disclosing, and it does reach this
 * pack: it is why the scorecard's cash conversion cycle prints its reason
 * instead of a number (`NO_INVENTORY_CLASSIFIED`, shared rather than
 * restated). So the caveat is reworded to state the fact and name what it
 * actually costs HERE, rather than dropped.
 *
 * AND IT NAMES THE CONSEQUENCE, NOT THE REMEDY. The first rewording ended
 * "classify the stock control account for one" — a job card for whoever
 * maintains the chart of accounts, printed in a caveat a board reads. That is
 * the same defect as the "Set `account_subtype` to 'inventory'" sentence this
 * caveat replaced; only the vocabulary had changed, so `checkProse`'s schema
 * rule no longer matched it. A director cannot act on it and is not meant to:
 * what they need is which measure is missing and what they are reading
 * instead. `packProseIntegrity`'s `a remedy addressed to an operator` rule
 * now fails a pack that gives ledger instructions in board prose, in any
 * vocabulary.
 *
 * 187 characters against the old 191, and the ceiling is real: page 12 drops
 * prose when this caveat grows — see `packPagesKeepTheirProse`.
 */
const INVENTORY_CAVEAT =
  `${NO_INVENTORY_CLASSIFIED} No acid-test ratio is published; liquidity is read off the current `
  + `ratio alone.`;

const STANDARD = 'IFRS for SMEs';
const SOURCE_SYSTEM = 'IsaFlow general ledger';
const CURRENCY = 'ZAR';

/**
 * The pack's ONE scale, exported so a statement table's own header and the
 * document's `numberConvention` cannot state different ones — two constants
 * spelling "R'000" is one edit away from a table headed in thousands whose
 * cells are formatted in rands. Typed `MoneyScale` so `formatMoney` accepts
 * it without a cast at the render boundary.
 */
export const PACK_SCALE: MoneyScale = "R'000";

/**
 * Every statement stated in a scale needs this, and none of the pack's pages
 * carried it. Rounded components genuinely do not always sum to a rounded
 * total — a reader who adds a column and finds it a thousand out is entitled
 * to know that is the rounding rather than an error in the pack.
 */
export const ROUNDING_NOTE =
  "Figures are rounded to the nearest R'000, so components may not add exactly to the totals shown.";

/** The same statement as a page footnote, for the statement pages. */
export const ROUNDING_FOOTNOTES: PackFootnote[] = [{ number: 1, text: ROUNDING_NOTE }];

/**
 * A statement page's footnotes: the rounding note, and — when the page shows a
 * prior column — WHICH period that column is.
 *
 * Spec §7.2 asks that the comparative be the period claimed in the header, and
 * a column headed only "Prior" claims nothing a reader can check. The text is
 * built from `comparative.label` rather than re-formatted here, so the printed
 * claim and the one the integrity gate checks are the same string; a second
 * formatting of the same dates is how the page and the gate start disagreeing.
 */
export function statementFootnotes(comparative: PackComparativePeriod | null): PackFootnote[] {
  if (comparative === null) return ROUNDING_FOOTNOTES;
  return [
    ...ROUNDING_FOOTNOTES,
    { number: 2, text: `The prior column is the period ${comparative.label}.` },
  ];
}

/** The part-month sentence for this series, or null. */
function partialFor(trend: PackTrendPoint[]): string | null {
  const point = partialMonthOf(trend);
  return point === null ? null : partialMonthBasisNote(point);
}

/**
 * ONE LINE OF THE GLOSSARY'S TWO COLUMNS, AND IT HAS TO BE.
 *
 * It read "unavailable — no ledger watermark was supplied for this pack
 * render" and set at 8.5pt across an 83mm column that is two lines. Page 12
 * of the live Brightsphere pack composes at 257.0mm in a 255mm box, and the
 * note the fitter takes to pay for that is the LAST note of the basis block —
 * this one. The eight basis facts are the reason the page exists
 * (`packBasisMetadataKept.test.ts` names all eight), so the value says the
 * same thing in one line instead of buying the paper out of the fact.
 */
const LEDGER_VERSION_UNAVAILABLE =
  'unavailable — none supplied for this render';


/**
 * @param ledgerVersion The ledger state this pack was rendered against —
 *   typically `getLedgerPostedThrough(companyId, window)`'s result, fetched
 *   once by the page-12 assembler. `null` when the caller has none to give;
 *   rendered as an explicit "unavailable" statement, never invented.
 * @param trend The monthly series the pack draws, read for ONE fact: whether
 *   its last month is a PART month. That is a statement about the window
 *   every monthly figure in this pack was measured over, so it belongs on the
 *   basis page — which said nothing about it while page 10 quoted a gross
 *   margin of 100.0% taken over seven days. See `packPartialMonth.ts`.
 */
export function buildBasis(
  set: PackFigureSet,
  doc: Pick<PackPagesDocument, 'generatedAt'>,
  draftReasons: PackDraftReason[],
  ledgerVersion: string | null,
  trend: PackTrendPoint[],
  /** The document's provenance map — EBITDA's reconciliation is made of
   *  FIGURES, and a figure on a page that no service issued is what the
   *  integrity gate exists to refuse. */
  p: PackFigureProvenance,
): PackBasis {
  const caveats: string[] = [];
  if (set.current.classificationCaveat) caveats.push(set.current.classificationCaveat);
  if (set.current.inventoryCaveat) caveats.push(INVENTORY_CAVEAT);
  // The SAME sentence the cover prints — one definition, because they are one
  // claim, and a pack whose cover says DRAFT while its caveats do not is a
  // pack that disagrees with itself about its own status.
  if (draftReasons.length > 0) caveats.push(draftStatusSentence(draftReasons));

  return {
    basisOfPreparation: {
      standard: STANDARD,
      sourceSystem: SOURCE_SYSTEM,
      // BOTH IN WORDS, ON THE COMPANY'S OWN CLOCK. The page printed
      // `2026-09-07T06:22:04.572Z` — a machine's format, to the millisecond,
      // in a timezone nobody in the business is on. See `formatPackTimestamp`;
      // it leaves the "no ledger watermark" sentence alone.
      extractedAt: formatPackTimestamp(doc.generatedAt),
      ledgerVersion: formatPackTimestamp(ledgerVersion ?? LEDGER_VERSION_UNAVAILABLE),
    },
    numberConvention: { scale: PACK_SCALE, currency: CURRENCY },
    definitions: buildDefinitions(set, p),
    // A STATEMENT ABOUT THE WINDOW, so it rides on the Period fact rather
    // than becoming a fourth caveat — see `partialMonthBasisNote`.
    partialMonth: partialFor(trend),
    caveats,
  };
}
