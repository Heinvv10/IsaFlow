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
  PackDefinition,
  PackNumberConvention,
  PackPagesDocument,
} from './packPageModel';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { formatPackTimestamp } from './packPeriodLabel';
import { draftStatusSentence, type PackDraftReason } from './packDraftStatus';
import { ledgerStalenessCaveat } from './packLedgerCurrency';
import { buildDefinitions } from './packDefinitions';
import { PACK_SCALE } from './packScale';
import { liquidityMetricNames, NO_INVENTORY_CLASSIFIED } from './packScorecard';
import type { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
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
  /**
   * THE ONE CAVEAT THE COVER PRINTS, or null where the ledger reaches the
   * period end — `ledgerStalenessCaveat`, surfaced by itself.
   *
   * It is already in `caveats`, and the contents page prints it there. The
   * COVER needs it separately because a cover cannot carry a list: it carries
   * the two or three facts that govern how the whole document is read, and on
   * Brightsphere the fact that nothing has been posted since 29 April — five
   * of the period's months nil — governs all twelve sheets and waited until
   * page 2. A reader who reads only the cover met "1 January 2026 to
   * 7 September 2026" with no hint that four of those months are empty.
   *
   * Conditional and derived, in the slot the part-month note already
   * occupies, so a company whose ledger is current is unaffected and the two
   * covers stay symmetric in rule if not in content.
   */
  ledgerCaveat: string | null;
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
 *
 * AND THE SECOND HALF NAMES THE MEASURES OFF THE SCORECARD ITSELF. It read
 * "liquidity is read off the current ratio alone" and page 9's section B
 * prints the current ratio AND the cash ratio — a limitation the pack
 * contradicts seven sheets later, in its own list of limitations. That
 * sentence was itself the fix for a caveat which discussed a quick ratio the
 * pack never printed, so this is the same defect twice: a claim about what
 * page 9 shows, written without looking at page 9. `liquidityMetricNames`
 * reads the scorecard's own group, so the caveat cannot survive a change to
 * the section it describes.
 */
const INVENTORY_CAVEAT =
  `${NO_INVENTORY_CLASSIFIED} No acid-test ratio is published; liquidity is read off `
  + `${measureList(liquidityMetricNames())}.`;

/** "a, b and c". */
function inWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

/**
 * A list of scorecard metric names, mid-sentence, AS A PERSON WOULD WRITE IT.
 *
 * The names are row labels — "Current ratio", "Cash ratio" — so they are
 * capitalised where they print and are not proper nouns here. Where they all
 * end on the same noun the noun is said once and pluralised ("the current and
 * cash ratios"); otherwise each is written out. That is not decoration: the
 * caveat has a 191-character ceiling it is held to by test, and the full
 * join is 200. Making the sentence shorter by hand is what put a false claim
 * in it twice, so the shortening is a rule over the names rather than a
 * choice about them.
 */
function measureList(names: string[]): string {
  if (names.length === 0) return 'nothing on the scorecard';
  const words = names.map((name) => name.toLowerCase().split(' '));
  const noun = words[0]![words[0]!.length - 1]!;
  if (names.length > 1 && words.every((w) => w[w.length - 1] === noun)) {
    return `the ${inWords(words.map((w) => w.slice(0, -1).join(' ')))} ${noun}s`;
  }
  if (names.length === 1) return `the ${words[0]!.join(' ')} alone`;
  return inWords(words.map((w) => `the ${w.join(' ')}`));
}

const STANDARD = 'IFRS for SMEs';
const SOURCE_SYSTEM = 'IsaFlow general ledger';
const CURRENCY = 'ZAR';

/** The pack's one scale lives in `packScale.ts` — a leaf, so the glossary
 *  this file builds can read it without importing this file back. Re-exported
 *  because every existing caller imports it from here. */
export { PACK_SCALE };

/** The rounding convention and the statement pages' footnotes live in
 *  `packStatementFootnotes.ts`, split out for the 300-line cap. Re-exported
 *  because every existing caller imports them from here. */
export {
  ROUNDING_COMPONENTS_NOTE,
  ROUNDING_RATIOS_NOTE,
  ROUNDING_NOTE,
  ROUNDING_FOOTNOTES,
  statementFootnotes,
  priorColumnFootnote,
} from './packStatementFootnotes';

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
  /**
   * The trend panel ids this pack actually DRAWS.
   *
   * Page 12 defines what the trends page does with a measure, and
   * Brightsphere's trends page draws no debtor-days panel — so its glossary
   * defined a variant that pack does not print. A definition is a claim about
   * the document; it has to be able to ask the document. Defaults to the full
   * set so a caller that cannot say keeps the pack's general definitions.
   */
  drawnPanelIds: ReadonlySet<string> = new Set(['trend-debtor-days']),
): PackBasis {
  const caveats: string[] = [];
  if (set.current.classificationCaveat) caveats.push(set.current.classificationCaveat);
  if (set.current.inventoryCaveat) caveats.push(INVENTORY_CAVEAT);
  // HOW CURRENT THE FIGURES ARE IS A CAVEAT, NOT ONLY A SHEET-4 BLOCK.
  //
  // The demo pack's period qualification — the fiscal period it ends in is
  // still open — reaches the cover and the contents page. Brightsphere's is
  // larger and surfaced once: nothing has been posted since 29 April, five
  // months before the period end, stated on sheet 4 alone while its cover and
  // caveats said only that no commentary had been approved. A director
  // reading sheets 1 to 3 formed a view of a period the ledger never covered.
  const stale = ledgerStalenessCaveat(ledgerVersion, trend, set.currentWindow.end);
  if (stale !== null) caveats.push(stale);
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
    definitions: buildDefinitions(set, p, drawnPanelIds),
    // A STATEMENT ABOUT THE WINDOW, so it rides on the Period fact rather
    // than becoming a fourth caveat — see `partialMonthBasisNote`.
    partialMonth: partialFor(trend),
    caveats,
    ledgerCaveat: stale,
  };
}
