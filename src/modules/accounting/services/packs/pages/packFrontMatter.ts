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
import { PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import type { PackBasis } from './packBasis';
import type { MoneyScale } from '@/lib/format/money';
import type { PackComparativePeriod, PackPage } from './packPageModel';

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
      ]),
    ]),
    page('Contents', 'Contents', 'Front', 'low', [
      disclose('Basis of preparation', [
        note('In short', `${f.basis.basisOfPreparation.standard}. ${f.period}. Figures in ${f.scale} (${f.currency}), ${f.draftReasons.length > 0 ? 'draft' : 'final'}. Full basis on page ${f.basisPageNumber}.`),
      ]),
    ]),
  ];
}

/** The last page — spec §4.A page 12. */
export function buildBasisPage(
  basis: PackBasis,
  period: string,
  comparativePeriod: PackComparativePeriod | null,
  scale: MoneyScale,
  currency: string,
): UnnumberedPage {
  // A CONCLUSION, not the page's own name restated. It read "Basis of
  // preparation" over "Basis of preparation and definitions"; what a director
  // needs from the headline is what standard the figures were prepared under,
  // at what scale, and whether anything qualifies them.
  const title = basisTitle(basis, scale, basis.caveats.length);
  return page(title, 'Basis of preparation', 'Governance', 'medium', [
    disclose('Basis of preparation', [
      note('Standard', basis.basisOfPreparation.standard),
      note('Period', period),
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
    // REQUIRED, so it is the LAST prose on this page the fitter may take and
    // its first note can never be taken at all. It was optional and it is the
    // page's last block, which made a caveat qualifying the figures the FIRST
    // thing dropped when the page ran short — ahead of "Rounding" and "Ledger
    // version" three centimetres above it. A qualification of the numbers
    // outranks a fact about how they were extracted.
    mustDisclose('Caveats', basis.caveats.length > 0
      ? basis.caveats.map((caveat, index) => note(`Caveat ${index + 1}`, caveat))
      : [note('None', 'No classification or inventory caveat applies to these figures.')]),
  ]);
}

/** The basis page's conclusion standfirst, for a page printing `caveats` of
 *  them. */
function basisTitle(basis: PackBasis, scale: MoneyScale, caveats: number): string {
  const clause = caveats === 0
    ? 'no caveat qualifies these figures'
    : `${caveats === 1 ? 'one caveat qualifies' : `${caveats} caveats qualify`} these figures`;
  return `Prepared under ${basis.basisOfPreparation.standard} from the `
    + `${basis.basisOfPreparation.sourceSystem}, in ${scale}; ${clause}.`;
}

/** How many caveats a composed basis page actually prints. */
function printedCaveats(page: UnnumberedPage, basis: PackBasis): number {
  if (basis.caveats.length === 0) return 0;
  for (const block of page.blocks) {
    if (block.kind === 'disclosure' && block.disclosure.heading === 'Caveats') {
      return block.disclosure.notes.length;
    }
  }
  return 0;
}

/**
 * THE BASIS PAGE, FITTED TO ITS SHEET AND TITLED BY WHAT IT ACTUALLY PRINTS.
 *
 * The rendered pack's standfirst read "…in R'000; 2 caveats qualify these
 * figures", one caveat was printed, and the page's own footer then admitted
 * "Not printed on this page: 1 explanatory note, from 'Caveats'". A
 * governance page that miscounts its own qualifications is the single worst
 * line in a board pack: it is not a layout complaint, it is the page telling
 * a director there is a second qualification and then not saying what it is.
 *
 * The count is composed BEFORE the page is held to its sheet, so the only
 * honest fix is to compose the title again afterwards, against the notes that
 * survived. Re-fitted after the retitle because a title is a page's tallest
 * text and a shorter one can free a line — and iterated, because that freed
 * line can bring a caveat back and change the count again. It converges in
 * one or two turns and stops either way: a title that says fewer caveats than
 * the page prints would be the same defect pointing the other direction.
 */
export function fitBasisPage(page: UnnumberedPage, basis: PackBasis, scale: MoneyScale): UnnumberedPage {
  let fitted = fitPageToBox(page);
  for (let turn = 0; turn < 3; turn += 1) {
    const printed = printedCaveats(fitted, basis);
    const title = basisTitle(basis, scale, printed);
    if (fitted.title === title) return fitted;
    fitted = fitPageToBox({ ...page, title });
  }
  return fitted;
}
