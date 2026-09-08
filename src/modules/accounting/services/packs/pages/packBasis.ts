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
import { comparativeLengthClause, formatPackTimestamp } from './packPeriodLabel';
import type { PeriodWindow } from '@/modules/accounting/services/reports/priorPeriod';
import { draftStatusSentence, type PackDraftReason } from './packDraftStatus';
import { ledgerStalenessCaveat } from './packLedgerCurrency';
import { buildDefinitions } from './packDefinitions';
import { liquidityMetricNames, NO_INVENTORY_CLASSIFIED } from './packScorecard';
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
export const ROUNDING_COMPONENTS_NOTE =
  "Figures are rounded to the nearest R'000, so components may not add exactly to the totals shown.";

/**
 * AND THE HALF OF ROUNDING THAT IS NOT ABOUT ADDING UP.
 *
 * The note above covers a column that does not foot. It says nothing about a
 * QUOTIENT, and on a small revenue base the quotient is where rounding does
 * its real damage: the demo pack's revenue is R101 424, printed 101, and its
 * gross margin of (1 329) over that base prints (1310.8%) where a director
 * dividing the two figures in front of them gets (1315.8%). Five percentage
 * points, on the two most prominent numbers in the pack — page 3's headline
 * tile and page 6's headline — with nothing anywhere saying why. The figures
 * were right and the disclosure was missing, which is the more expensive of
 * the two on a document whose argument is that its numbers can be checked.
 *
 * IT NAMES WHAT IT IS TRUE OF, BECAUSE TWO FAMILIES OF PERCENTAGE PRINT IN
 * THIS PACK AND THEY ARE COMPUTED DIFFERENTLY ON PURPOSE. A margin, a change
 * percentage, a share of revenue in a statement column and every scorecard
 * ratio come off the ledger's own unrounded amounts, and those are the ones
 * that will not reproduce. Page 10's scale shares and page 5's biggest-month
 * share are taken on the PRINTED figures, deliberately (`atScale`), because
 * those two sheets invite the reader to do the division off the paper — so a
 * blanket "ratios are computed before rounding" would be false exactly where
 * the pack has gone to the most trouble to be checkable. Saying "a ratio
 * taken on the unrounded figures" scopes the claim to the family it is about
 * and says nothing about the other, which is the difference between a rule
 * this document keeps and one it states and draws around.
 *
 * AND IT IS ONE LINE OF PAPER, WHICH IS WHAT IT COST. Page 12 composes with
 * about 2mm to spare on the tightest fixture, and this clause is four lines
 * of an 83mm column. It is paid for out of the `Not meaningful (n/m)` entry,
 * which said "never a zero — which would say the measure was taken and found
 * to be nothing" immediately before defining the dash as exactly that zero,
 * and closed by restating "too small to show at this scale" a second time.
 * Restatement for a fact, which is the only trade this page has left.
 */
export const ROUNDING_RATIOS_NOTE =
  'A ratio taken on the unrounded figures may not reproduce from the rounded ones beside it.';

/** The pack's ONE rounding convention, both halves of it. One string, because
 *  two wordings of one convention is one edit away from a basis page and a
 *  statement footnote disagreeing about how this pack rounds. */
export const ROUNDING_NOTE = `${ROUNDING_COMPONENTS_NOTE} ${ROUNDING_RATIOS_NOTE}`;

/**
 * The same convention as a page footnote, for the statement pages.
 *
 * THE COMPONENTS HALF ONLY, AND THAT IS MEASURED RATHER THAN CHOSEN. The
 * ratio clause belongs here too — the `% of revenue` column and the change
 * percentages print on these very sheets, which is where a reader meets the
 * discrepancy — and it does not fit. Carried in footnote 1 it takes the
 * required window note off sheet 5 on both companies and puts page 3 past
 * its box; the suite goes red on four files. Page 3's Scale note is the same
 * trade for the same reason.
 *
 * It is the same STRING either way — `ROUNDING_RATIOS_NOTE` is written once
 * and page 12 prints both halves — so the footnote and the basis page can
 * never disagree about how this pack rounds; the footnote simply says less,
 * and a reader following it lands on the page where the pack declares every
 * one of its conventions.
 */
export const ROUNDING_FOOTNOTES: PackFootnote[] = [{ number: 1, text: ROUNDING_COMPONENTS_NOTE }];

/**
 * A statement page's footnotes: the rounding note, and — when the page shows a
 * prior column — WHICH period that column is.
 *
 * Spec §7.2 asks that the comparative be the period claimed in the header, and
 * a column headed only "Prior" claims nothing a reader can check. The text is
 * built from `comparative.label` rather than re-formatted here, so the printed
 * claim and the one the integrity gate checks are the same string; a second
 * formatting of the same dates is how the page and the gate start disagreeing.
 *
 * AND ITS LENGTH, BESIDE THE COLUMN IT QUALIFIES. 1 January to 7 September
 * 2026 is 250 days and 26 April to 31 December 2025 is also 250 — which is
 * what makes the prior column, every change percentage taken across it and
 * every annualised day count comparable at all, and the pack stated it
 * nowhere. `comparativeLengthClause` MEASURES the two windows rather than
 * asserting a match, so a pack whose comparative is a different length prints
 * the mismatch in the same place.
 *
 * HERE AND NOT ON PAGE 12, AND THAT WAS MEASURED. Page 12's own "Comparative
 * period" fact reads across an 83mm column at 8.5pt and is one line with five
 * characters to spare, so any clause at all takes it to two — and on the live
 * demo fixture whose EBITDA bridge rounds, page 12 composes at 252.41mm in a
 * 255mm box, so that line costs 4.24mm the sheet does not have and
 * `fitPageToBox` answers by dropping the Colour key. This footnote is one
 * line with 57 characters spare on all three statement pages, and it prints
 * directly under the column it is about rather than three sheets away.
 */
export function statementFootnotes(
  comparative: PackComparativePeriod | null,
  /** The window the ACTUAL column was read over — see `comparativeLengthClause`. */
  reportingWindow: PeriodWindow,
): PackFootnote[] {
  if (comparative === null) return ROUNDING_FOOTNOTES;
  return [...ROUNDING_FOOTNOTES, priorColumnFootnote(comparative, reportingWindow, 2)];
}

/**
 * THE COMPARATIVE'S PERIOD, AS ONE SENTENCE FOR EVERY SHEET THAT PRINTS A
 * PRIOR COLUMN.
 *
 * Pages 6, 7 and 8 each marked their PRIOR heading and pointed here. Page 9
 * prints PRIOR five times and marked none — on the sheet where the
 * comparative is most treacherous: creditor days prior of 1 035 is a 365-day
 * annualisation taken over a 250-day comparative, and the prior current and
 * cash ratios both read (0.05). The rule was applied to three sheets of four.
 *
 * It takes its NUMBER from the caller because page 9's footnote numbering is
 * its own — the debtor-days note is 1 there when the trends page draws that
 * panel — and it is one function because four sheets stating the comparative
 * period in four places is four places for it to drift.
 */
export function priorColumnFootnote(
  comparative: PackComparativePeriod,
  reportingWindow: PeriodWindow,
  number: number,
): PackFootnote {
  return {
    number,
    text: `The prior column is the period ${comparative.label} — `
      + `${comparativeLengthClause(reportingWindow, comparative)}`,
  };
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
  };
}
