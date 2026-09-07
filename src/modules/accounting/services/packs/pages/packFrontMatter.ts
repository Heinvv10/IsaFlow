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
import { formatPackDate } from './packPeriodLabel';
import { ROUNDING_NOTE } from './packBasis';
import { draftStatusSentence, type PackDraftReason } from './packDraftStatus';
import { disclose, mustDisclose, note } from './packPageBlocks';
import { fitPageToBox } from './packPageFit';
import { lines, PAGE_WIDTH_MM, PT_MM, wrappedLines } from './packTextMetrics';
import { PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import type { PackBasis } from './packBasis';
import type { MoneyScale } from '@/lib/format/money';
import type { PackComparativePeriod, PackPage, PackPageBlock } from './packPageModel';

/** A page before it knows its own number — see `numbered` in
 *  `boardPackPages.ts`, which is the only thing that assigns one. */
export type UnnumberedPage = Omit<PackPage, 'number'>;

/**
 * Page numbers, from POSITION in the sequence.
 *
 * They used to be literals at each `page(...)` call — `page(4, …)`,
 * `page(12, …)`. The sequence is fixed at twelve by spec §4.A (R-P57) and
 * those agreed with the spec's own numbering, so nothing about the printed
 * pack changed. What changed is that the contents, the footer and page 2's
 * "full basis on page N" now READ the sequence instead of restating it: the
 * rendered pack printed "Full basis on page 12" while the basis was on sheet
 * 19, and a literal cannot notice.
 */
export function numbered(pages: UnnumberedPage[]): PackPage[] {
  return pages.map((page, index) => ({ ...page, number: index + 1 }));
}

/**
 * @param navLabel The short name for the contents. `title` is a CONCLUSION by
 *   rule, so an index built from it lists sentences rather than page names.
 */
export function page(
  title: string,
  navLabel: string,
  section: PackPage['section'],
  density: PackPage['density'],
  blocks: PackPage['blocks'],
  orientation: PackPage['orientation'] = 'portrait',
  footnotes: PackPage['footnotes'] = [],
): UnnumberedPage {
  return { title, navLabel, section, orientation, density, blocks, footnotes };
}

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
        note('Preparation', `Prepared by ${f.preparedBy} on ${formatPackDate(f.generatedAt.slice(0, 10))}. ${draftStatusSentence(f.draftReasons)}`),
        // THE SAME FACT ON BOTH COVERS, FROM THE SAME RULE — see
        // `PackFrontMatter.partialMonth`. Its own note rather than appended
        // to the preparation sentence: the cover is the lowest-density sheet
        // in the pack (about 15% ink) and this is a statement about the
        // FIGURES, not about who prepared them or when.
        ...(f.partialMonth === null ? [] : [note('Period covered', f.partialMonth)]),
      ]),
    ]),
    page('Contents', 'Contents', 'Front', 'low', [
      disclose('Basis of preparation', [
        note('In short', `${f.basis.basisOfPreparation.standard}. ${f.period}. Figures in ${f.scale} (${f.currency}), ${f.draftReasons.length > 0 ? 'draft' : 'final'}. Full basis on page ${f.basisPageNumber}.`),
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

/**
 * The one palette, in the fewest words that still name all three systems.
 *
 * Short because page 12 is the tightest sheet in the pack — on the live
 * Brightsphere ledger it composes within about two millimetres of its box,
 * and `fitPageToBox` pays for a long note by taking the ledger version and
 * the extraction time off the fact list above it. A colour key is not worth
 * the pack's own provenance.
 */
const COLOUR_KEY =
  'On the bridges, green is an income line, red a cost line and dark ink a total; '
  + 'the two also differ in lightness, so a monochrome copy still separates them. '
  + 'The balance sheet\'s bands are one ink at three lightnesses, legended on the chart. '
  + 'Red on the scorecard marks a missed target.';

/** The last page — spec §4.A page 12. */
export function buildBasisPage(
  basis: PackBasis,
  period: string,
  comparativePeriod: PackComparativePeriod | null,
  scale: MoneyScale,
  currency: string,
  /** The caveats the CONTENTS page composed — see `printedCaveats`. Passed in
   *  rather than read off `basis`, because this sentence must count what a
   *  reader can actually turn to, and the contents page is held to its sheet
   *  like every other. */
  caveatsPrinted: number,
): UnnumberedPage {
  // A CONCLUSION, not the page's own name restated. It read "Basis of
  // preparation" over "Basis of preparation and definitions"; what a director
  // needs from the headline is what standard the figures were prepared under,
  // at what scale, and whether anything qualifies them.
  const title = basisTitle(basis, scale, caveatsPrinted);
  return page(title, BASIS_NAV_LABEL, 'Governance', 'medium', [
    disclose('Basis of preparation', [
      note('Standard', basis.basisOfPreparation.standard),
      // AND WHICH PART OF IT THE MONTHLY SERIES DOES NOT COVER IN FULL. The
      // series runs to the month CONTAINING the reporting date, so on a pack
      // run mid-month its last point is a stub — and page 10 quoted one as a
      // gross margin of 100.0%. See `partialMonthBasisNote`.
      note('Period', basis.partialMonth === null ? period : `${period}. ${basis.partialMonth}`),
      note('Comparative period', comparativePeriod === null
        ? 'None. There is no prior period with a ledger to compare against, so no statement carries a comparative column.'
        : comparativePeriod.label),
      note('Currency and rounding', `${currency}, figures in ${scale}.`),
      note('Source system', basis.basisOfPreparation.sourceSystem),
      note('Rounding', ROUNDING_NOTE),
      note('Extracted at', basis.basisOfPreparation.extractedAt),
      note('Ledger version', basis.basisOfPreparation.ledgerVersion),
    // TWO COLUMNS. Eight label-and-value facts set across the full 174mm
    // measure cost 62mm of the sheet, most of it white to the right of
    // "Standard IFRS for SMEs" — on the one page that also has to carry a
    // sixteen-term glossary.
    ], 2),
    { kind: 'definitions', entries: basis.definitions },
    // THE PACK'S ONE COLOUR KEY, ON THE PAGE THAT STATES ITS CONVENTIONS.
    //
    // Three colour systems ran through the pack and this page defined none
    // of them, so red meant a cost on sheet 6 and a missed target on sheet 9
    // with nothing connecting the two. Stated here rather than repeated as a
    // legend on each chart: it is a convention of the document, like the
    // bracket for a negative in the glossary above.
    //
    // ITS OWN BLOCK, not a ninth fact in the list at the top. As a fact it
    // is four lines in an 83mm column, and the balanced two-column block
    // charges half of them to the page — which on the live Brightsphere
    // ledger is more paper than the sheet has, and the fitter pays for it by
    // taking the ledger version and the extraction time off the pack's own
    // provenance. As a block it is the LAST prose on the page and the page
    // has the room, because the caveats moved to the contents.
    disclose('Colour', [note('Key', COLOUR_KEY)]),
    // THE CAVEATS ARE NOT HERE. They print with the contents — see
    // `buildFrontPages` — and the standfirst above says so and counts them.
  ]);
}

/** The basis page's conclusion standfirst, for a page printing `caveats` of
 *  them. */
function basisTitle(basis: PackBasis, scale: MoneyScale, caveats: number): string {
  const clause = caveats === 0
    ? 'no caveat qualifies these figures'
    : `${caveats === 1 ? 'one caveat qualifies' : `${caveats} caveats qualify`} these figures, `
      + 'printed with the contents';
  return `Prepared under ${basis.basisOfPreparation.standard} from the `
    + `${basis.basisOfPreparation.sourceSystem}, in ${scale}; ${clause}.`;
}

/**
 * THE CONTENTS PAGE, HELD TO ITS SHEET.
 *
 * It carries the caveats now, and a company with four long ones would
 * otherwise push the pack to a thirteenth sheet from the FRONT — the one
 * place nothing was measured, because until now page 2 was a twelve-line
 * index and a paragraph. The caveats are a required disclosure, so the
 * fitter reaches them only after this page's own optional prose, never takes
 * the first of them, and says on the page what it took.
 *
 * WHATEVER IT TAKES, THE BASIS PAGE'S STANDFIRST HAS TO KNOW. That sentence
 * counts the caveats that qualify the figures and names where they print; a
 * count composed before this fit is a count this fit can falsify, which is
 * the exact defect the basis page was rejected for once already. So the
 * caller fits this page FIRST and hands `printedCaveats` to
 * `buildBasisPage` — see `boardPackPages`.
 */
export function fitContentsPage(page: UnnumberedPage, navLabels: string[]): UnnumberedPage {
  return fitPageToBox(page, contentsListMm(navLabels));
}

/** The name page 12 goes by in the index. A constant because the contents
 *  page is measured before that page is composed — see `contentsListMm`. */
export const BASIS_NAV_LABEL = 'Basis of preparation';

/**
 * The measure a contents row sets its LABEL across.
 *
 * `.pack-contents-item` is a flex row: the page number, then the label, then
 * the space between them. The number is one or two figures at 10pt with a 3mm
 * margin — under 8mm — and 10 is the pessimistic reading of it, because the
 * direction that matters here is the one that spills a sheet.
 */
const CONTENTS_LABEL_MM = PAGE_WIDTH_MM.portrait - 10;

/**
 * The paper `PackContents` draws that this page's BLOCKS do not account for:
 * the index itself.
 *
 * It is not a block — the component builds it from the page list — so
 * `pageMm` reports this sheet at a third of its real height, which was
 * harmless while the page carried one paragraph and is not now that it
 * carries the caveats. Transcribed from `.pack-contents-list` and
 * `.pack-contents-item` in `packPrint.css`: a 4mm top margin, then per row a
 * 10pt line at 16pt leading, 1mm of padding either side and a half-point
 * rule.
 *
 * IT TAKES THE LABELS, NOT A COUNT, AND THAT IS THE CORRECTION. It assumed
 * one line per entry and never saw the strings. Twelve short labels — "Income
 * statement", "Matters" — fit that assumption; an eighteen-page management
 * pack with longer ones does not, and a wrapped label makes this formula
 * UNDER-read, which is the one direction that puts a page on a second sheet
 * under an index that says otherwise. It is now measured the way every other
 * block on every other page is measured, through `wrappedLines`, and
 * `packSheetCount.test.ts` holds page 2 to Chromium's own layout like the
 * ten pages after it.
 */
export function contentsListMm(navLabels: string[]): number {
  const rowLines = navLabels.reduce(
    (sum, label) => sum + wrappedLines(label, 10, CONTENTS_LABEL_MM), 0);
  return 4 + lines(rowLines, 16) + navLabels.length * (2 + 0.5 * PT_MM);
}
