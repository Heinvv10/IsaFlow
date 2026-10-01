/**
 * The board pack's FRONT and BACK matter — the cover, the contents, and the
 * basis-of-preparation page — split out of `boardPackPages.ts` at the
 * 300-line ceiling.
 *
 * The seam is the one the pack itself draws. Everything here is 'Front' or
 * 'Governance' section: it states what the document IS and how it was
 * prepared, and reads no figure set at all. `boardPackPages.ts` keeps the
 * pages that report the period.
 */
import { formatPackDate, packDateOf } from './packPeriodLabel';
import { draftStatusSentence, type PackDraftReason } from './packDraftStatus';
import { disclose, mustDisclose, note } from './packPageBlocks';
import { page, type UnnumberedPage } from './packUnnumberedPage';
import { PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import type { PackBasis } from './packBasis';
import type { MoneyScale } from '@/lib/format/money';
import type { PackPageBlock } from './packPageModel';

/** The page constructor, the basis page and the contents fit split to
 *  `packUnnumberedPage.ts`, `packBasisPage.ts` and `packContentsFit.ts` for
 *  the 300-line cap. Re-exported because every existing caller imports them
 *  here. */
export { numbered, page } from './packUnnumberedPage';
export type { UnnumberedPage };
export { buildBasisPage, BASIS_NAV_LABEL } from './packBasisPage';
export { fitContentsPage, contentsListMm } from './packContentsFit';

export interface PackFrontMatter {
  companyLegalName: string;
  period: string;
  preparedBy: string;
  generatedAt: string;
  /**
   * Every reason this pack is not final, or empty where it is. Not a
   * boolean: "the ledger is closed" and "a human has read this" are two
   * facts, and one flag carrying both is how Brightsphere's pack — no
   * approved commentary, inverted colours, three panel titles reading "rose
   * from – to –" — told a board it was FINAL. See `packDraftStatus.ts`.
   */
  draftReasons: PackDraftReason[];
  /**
   * The part-month sentence for this pack's series, or null where the period
   * ends on a whole month — `partialMonthClauseFor`, the pack's ONE wording.
   *
   * ON THE COVER BECAUSE THE COVER IS WHERE THE TWO PACKS DIVERGED. Demo's
   * cover says the pack is a draft because "the fiscal period it ends in is
   * still open, so these figures can still move"; Brightsphere's, whose
   * September period IS closed in the ledger, correctly drops that clause —
   * and so its reader is never told anywhere on the front of the pack that
   * the figures stop on the seventh of a thirty-day month. The eleventh gate
   * read the two covers side by side and could not tell which fact each was
   * reporting.
   *
   * The fix is not to drive "figures can still move" off the part month:
   * a closed period means the posted figures will NOT move, so that sentence
   * would be false on Brightsphere. The part month is a different fact — how
   * much of the last month the figures cover — and it is now stated as
   * itself, from the same rule, on both covers.
   */
  partialMonth: string | null;
  scale: MoneyScale;
  currency: string;
  basis: PackBasis;
  /** Where the full basis of preparation prints. Passed in rather than
   *  hard-coded as 12: it is the LAST page, and the pack is not always
   *  twelve pages long — the narrative page merges into its neighbour when
   *  no commentary has been approved (spec §5.7). A literal here sends a
   *  director to the scorecard for the basis of preparation. */
  basisPageNumber: number;
}

/**
 * The going-concern line page 2 prints — see the note that uses it.
 *
 * Exported so the tests read the string the page prints rather than a second
 * spelling of it, and so the day a going-concern assessment IS captured there
 * is one place that changes.
 */
export const GOING_CONCERN_NOTE =
  'This pack states no going-concern basis; the assessment is a matter for the board.';

/** Pages 1 and 2 — the cover and the contents. */
export function buildFrontPages(f: PackFrontMatter): UnnumberedPage[] {
  return [
    page(f.companyLegalName, 'Cover', 'Front', 'low', [
      disclose(PACK_CONFIDENTIALITY, [
        // THE DATE IN WORDS. `.slice(0, 10)` put `2026-09-07` on the cover of
        // a board pack — the storage format, on the first line a director
        // reads, in a document whose every other date is set in words.
        // AND IT SAYS WHICH. "DRAFT" alone tells a director to distrust the
        // pack without saying what to wait for; a period that closes next
        // week and a commentary nobody has written are different waits.
        note('Preparation', `Prepared by ${f.preparedBy} on ${formatPackDate(packDateOf(f.generatedAt))}. ${draftStatusSentence(f.draftReasons)}`),
        // THE SAME FACT ON BOTH COVERS, FROM THE SAME RULE — see
        // `PackFrontMatter.partialMonth`. Its own note rather than appended
        // to the preparation sentence: the cover is the lowest-density sheet
        // in the pack (about 15% ink) and this is a statement about the
        // FIGURES, not about who prepared them or when.
        ...(f.partialMonth === null ? [] : [note('Period covered', f.partialMonth)]),
        // AND HOW MUCH OF THAT PERIOD THE LEDGER ACTUALLY REACHES.
        //
        // Brightsphere's cover carried the DRAFT status and the part-month
        // note and left the fact that governs all twelve sheets — nothing
        // posted since 29 April, five of the period's months nil — until page
        // 2. A director who reads only the cover met a period of
        // 1 January to 7 September with no hint that four of those months are
        // empty. It is the same sentence page 2 and page 4 carry
        // (`ledgerStalenessCaveat`, one wording), in the slot the part-month
        // note already occupies, and it is conditional on the ledger: a
        // company whose ledger reaches the period end prints nothing here and
        // the demo cover is untouched.
        ...(f.basis.ledgerCaveat === null ? [] : [note('Ledger', f.basis.ledgerCaveat)]),
      ]),
    ]),
    page('Contents', 'Contents', 'Front', 'low', [
      // THE HEADING NO LONGER REPEATS THE ROW DIRECTLY ABOVE IT. The index's
      // last line is "12 Basis of preparation" and this block's H2 was the
      // same four words, separated from it by the table's hairline — for a
      // beat it read as a thirteenth contents row. It is a SUMMARY of that
      // sheet, and naming it as one says what it is and what page 12 is for.
      disclose('The basis, in short', [
        note('Standard and period', `${f.basis.basisOfPreparation.standard}. ${f.period}. Figures in ${f.scale} (${f.currency}), ${f.draftReasons.length > 0 ? 'draft' : 'final'}. Full basis on page ${f.basisPageNumber}.`),
        // THE BASIS THE FIGURES WERE PREPARED ON, WHICH THIS PACK CANNOT
        // ASSERT AND THEREFORE DOES NOT.
        //
        // Page 7 tells both companies that liabilities exceeding assets "may
        // affect covenant compliance and the going-concern assessment" — on
        // negative equity of (4 087) and (2 176) — and no sheet then said
        // what basis the figures were prepared on. For an entity in that
        // position it is the one basis element a director looks for, and a
        // pack that raises going concern and never states it is incomplete
        // in the way that matters most.
        //
        // IT SAYS THERE IS NONE RATHER THAN ASSERTING ONE. A going-concern
        // basis is a judgement about the twelve months after the reporting
        // date — funding, forecasts, undertakings — and nothing in this
        // ledger carries any of it. Printing "prepared on the going-concern
        // basis" would be the pack vouching for a conclusion it has no
        // evidence of, on the two companies where the conclusion is least
        // safe. A stated absence is something a board can act on; an
        // unsupported assertion is not.
        //
        // AND IT IS ON THIS SHEET RATHER THAN PAGE 12. Page 12 has 0.0mm of
        // paper spare on the shape whose EBITDA bridge does not add as
        // printed, and a ninth basis fact needs 4.2mm of it: it could only be
        // bought by dropping the Colour key, which is the pack's own reading
        // key for the bridges, and buying a disclosure by dropping one is not
        // a gain. This sheet is titled "The basis, in short" — it is a basis
        // sheet by its own name, it is where a reader meets the basis first,
        // and it has the room.
        //
        // UNCONDITIONAL, ON EVERY PACK AND EVERY SHAPE. Not "wherever it
        // fits", which would put it on page 12 for one company and here for
        // another — the asymmetry class this branch exists to close — and not
        // conditional on negative equity, which would make the sentence's
        // PRESENCE a signal about the figures.
        note('Going concern', GOING_CONCERN_NOTE),
      ]),
      // AND WHY THIS SHEET, AND SOME OF THE ONES IT INDEXES, ARE SHORT.
      //
      // Page 2 carries 2.4% ink against a pack median of 6.5% and runs out of
      // content 41% up the paper — three times emptier than any other sheet,
      // and the reader was left to decide whether that was a design or a
      // failed render. The pack has an answer and states it on page 11, about
      // page 11's table: it is the same twelve sheets for every company
      // however busy its ledger. That is a fact about the DOCUMENT, and the
      // contents page is where a reader meets the document.
      //
      // It is not the page-11 sentence restated: that one explains why a
      // TABLE is held to its paper, this one explains why a SHEET can be
      // mostly white. Both are the same design decision, said about the two
      // places a reader meets it.
      disclose('The shape of this pack', [
        note('Twelve sheets', 'This pack is the same twelve sheets for every company, whatever '
          + 'its ledger holds. A sheet with little on it is a company with little posted, not a '
          + 'page that failed to print; where a figure or a chart cannot be drawn, the sheet says '
          + 'so in place of it.'),
      ]),
      // THE QUALIFICATIONS, WITH THE CONTENTS, WHERE THEY ARE READ FIRST.
      //
      // They were the last block of the last sheet, under a sixteen-term
      // glossary — the furthest point in the document from where a director
      // starts. Two things move with them. This page was a twelve-line
      // index and one paragraph over about 60% white, which is a sheet that
      // looks like it failed to load; and page 12 was composing within two
      // millimetres of its box on the live Brightsphere ledger, with no room
      // for the colour key it owed the reader. A caveat is a statement about
      // what the figures are, so the front of the pack is where it belongs.
      //
      // REQUIRED, so `fitPageToBox` reaches them only after this page's own
      // optional prose is gone, and never takes the first.
      caveatsBlock(f.basis),
    ]),
  ];
}

/** The heading `printedCaveats` matches on, so the block and the count that
 *  reads it cannot drift apart on a rename. */
const CAVEATS_HEADING = 'Caveats';

function caveatsBlock(basis: PackBasis): PackPageBlock {
  return mustDisclose(CAVEATS_HEADING, basis.caveats.length > 0
    ? basis.caveats.map((caveat, index) => note(`Caveat ${index + 1}`, caveat))
    : [note('None', 'No classification or inventory caveat applies to these figures.')]);
}

/** How many caveats a composed page actually prints. */
export function printedCaveats(page: UnnumberedPage, basis: PackBasis): number {
  if (basis.caveats.length === 0) return 0;
  for (const block of page.blocks) {
    if (block.kind === 'disclosure' && block.disclosure.heading === CAVEATS_HEADING) {
      return block.disclosure.notes.length;
    }
  }
  return 0;
}
