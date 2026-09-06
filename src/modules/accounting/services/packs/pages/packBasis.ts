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
 * `ledgerVersion` is meant to be the traceability anchor a reader could use
 * to reproduce this exact render. The one company-scoped read this codebase
 * has for that purpose is `getLedgerPostedThrough` in `postedThroughService`,
 * but this function is deliberately synchronous — it only sees the
 * `PackFigureSet` its caller already fetched — so it falls back to
 * `set.budget.postedThrough` (null when the company has no budget, e.g.
 * Brightsphere) and states the gap plainly rather than borrowing
 * `generatedAt` and calling it a ledger watermark it is not. See the task
 * report for the follow-up this implies.
 */

import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type {
  PackBasisOfPreparation,
  PackDefinition,
  PackNumberConvention,
  PackPagesDocument,
} from './packPageModel';

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
const SCALE = "R'000";

/** Plain IFRS-adjacent ratios used elsewhere in the pack. Percentages and
 *  ratios are formulas, not non-IFRS dollar measures, so none of these
 *  carries a `reconciliation` — there is nothing to bridge from an IFRS
 *  figure to an adjusted one. If a genuinely adjusted measure (e.g. an
 *  "adjusted EBITDA") is ever introduced elsewhere in the pack, its
 *  definition belongs here WITH a `reconciliation`, per §7.1 criterion 12. */
const RATIO_DEFINITIONS: PackDefinition[] = [
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

function ledgerVersion(
  set: PackFigureSet,
  doc: Pick<PackPagesDocument, 'draft' | 'generatedAt'>,
): string {
  if (set.budget?.postedThrough) return set.budget.postedThrough;
  return `unavailable — no posted-ledger watermark for this window (pack generated ${doc.generatedAt})`;
}

export function buildBasis(
  set: PackFigureSet,
  doc: Pick<PackPagesDocument, 'draft' | 'generatedAt'>,
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
      ledgerVersion: ledgerVersion(set, doc),
    },
    numberConvention: { scale: SCALE, currency: CURRENCY },
    definitions: RATIO_DEFINITIONS,
    caveats,
  };
}
