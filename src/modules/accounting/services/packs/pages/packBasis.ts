/**
 * Page 12 — basis of preparation and definitions.
 *
 * What makes every number on the other eleven pages auditable: the standard
 * applied, the source system, when the ledger was read, and which ledger
 * state the pack was rendered against. Spec §7.1 criterion 12 fails a pack
 * where a non-IFRS measure has no reconciliation bridge — this pack does not
 * currently compute one (see `RATIO_DEFINITIONS` below), so the criterion is
 * satisfied by there being nothing unreconciled, not by an empty exemption.
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
import type { MoneyScale } from '@/lib/format/money';

export interface PackBasis {
  basisOfPreparation: PackBasisOfPreparation;
  numberConvention: PackNumberConvention;
  definitions: PackDefinition[];
  /** `classificationCaveat` / `inventoryCaveat` off the current figures,
   *  surfaced here rather than suppressed — see `reportPackDataService.ts`
   *  for what each means. Includes the draft watermark when `doc.draft`. */
  caveats: string[];
}

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

const LEDGER_VERSION_UNAVAILABLE =
  'unavailable — no ledger watermark was supplied for this pack render';

/** Plain IFRS-adjacent ratios used elsewhere in the pack. Percentages and
 *  ratios are formulas, not non-IFRS dollar measures, so none of these
 *  carries a `reconciliation` — there is nothing to bridge from an IFRS
 *  figure to an adjusted one. If a genuinely adjusted measure (e.g. an
 *  "adjusted EBITDA") is ever introduced elsewhere in the pack, its
 *  definition belongs here WITH a `reconciliation`, per §7.1 criterion 12. */
const RATIO_DEFINITIONS: PackDefinition[] = [
  {
    // STATED, because §7.1 criterion 8 asks for one number convention stated
    // and applied. A rendered pack showed `(1 546)`, `−1348.0%` and `-0.14`
    // within a few rows of each other on one sheet — an accounting bracket, a
    // U+2212 and an ASCII hyphen for the same idea — and page 12 named none of
    // them. `src/lib/format/money.ts` is where the applying happens.
    term: 'Negative figures',
    definition:
      'Shown in brackets — (1 546) — for currency, percentages and ratios alike. '
      + 'No minus sign is used anywhere in this pack.',
  },
  {
    term: 'Gross margin',
    definition: 'Gross profit (revenue less cost of sales), as a percentage of revenue.',
  },
  {
    term: 'Net profit margin',
    definition: 'Net profit, as a percentage of revenue.',
  },
  {
    term: 'Current ratio',
    definition: 'Current assets divided by current liabilities.',
  },
];

/**
 * @param ledgerVersion The ledger state this pack was rendered against —
 *   typically `getLedgerPostedThrough(companyId, window)`'s result, fetched
 *   once by the page-12 assembler. `null` when the caller has none to give;
 *   rendered as an explicit "unavailable" statement, never invented.
 */
export function buildBasis(
  set: PackFigureSet,
  doc: Pick<PackPagesDocument, 'draft' | 'generatedAt'>,
  ledgerVersion: string | null,
): PackBasis {
  const caveats: string[] = [];
  if (set.current.classificationCaveat) caveats.push(set.current.classificationCaveat);
  if (set.current.inventoryCaveat) caveats.push(set.current.inventoryCaveat);
  if (doc.draft) caveats.push('This pack is a DRAFT — figures are not final.');

  return {
    basisOfPreparation: {
      standard: STANDARD,
      sourceSystem: SOURCE_SYSTEM,
      extractedAt: doc.generatedAt,
      ledgerVersion: ledgerVersion ?? LEDGER_VERSION_UNAVAILABLE,
    },
    numberConvention: { scale: PACK_SCALE, currency: CURRENCY },
    definitions: RATIO_DEFINITIONS,
    caveats,
  };
}
