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
import { ROUNDING_NOTE } from './packBasis';
import { disclose, note } from './packPageBlocks';
import { PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import type { PackBasis } from './packBasis';
import type { MoneyScale } from '@/lib/format/money';
import type { PackComparativePeriod, PackPage } from './packPageModel';

/** A page before it knows its own number — see `numbered` in
 *  `boardPackPages.ts`, which is the only thing that assigns one. */
export type UnnumberedPage = Omit<PackPage, 'number'>;

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
  draft: boolean;
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
        note('Preparation', `Prepared by ${f.preparedBy} on ${f.generatedAt.slice(0, 10)}. This pack is ${f.draft ? 'a DRAFT — figures are not final' : 'FINAL'}.`),
      ]),
    ]),
    page('Contents', 'Contents', 'Front', 'low', [
      disclose('Basis of preparation', [
        note('In short', `${f.basis.basisOfPreparation.standard}. ${f.period}. Figures in ${f.scale} (${f.currency}), ${f.draft ? 'draft' : 'final'}. Full basis on page ${f.basisPageNumber}.`),
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
  return page('Basis of preparation and definitions', 'Basis of preparation', 'Governance', 'medium', [
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
    ]),
    { kind: 'definitions', entries: basis.definitions },
    disclose('Caveats', basis.caveats.length > 0
      ? basis.caveats.map((caveat, index) => note(`Caveat ${index + 1}`, caveat))
      : [note('None', 'No classification or inventory caveat applies to these figures.')]),
  ]);
}
