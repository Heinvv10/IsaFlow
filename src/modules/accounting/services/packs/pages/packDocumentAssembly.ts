/**
 * From the composed body to the document — the front pages, the contents
 * fit, the basis page composed from that fit, the numbering, and the
 * integrity gate. Lifted out of `buildBoardPackPages` whole for the 300-line
 * cap: the statements below are the composer's own, unchanged and in their
 * own order, and it is the last thing the composer calls.
 */
import { PACK_LABELS } from '@/modules/accounting/services/packs/packSections';
import type { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { MoneyScale } from '@/lib/format/money';
import type { PackBasis } from './packBasis';
import { partialMonthClauseFor } from './packPartialMonth';
import { fitPageToBox } from './packPageFit';
import { fitBodyPage } from './packNarrativeFit';
import { definitionsPrintedBy } from './packDefinitions';
import {
  buildBasisPage,
  buildFrontPages,
  BASIS_NAV_LABEL,
  fitContentsPage,
  numbered,
  printedCaveats,
  type UnnumberedPage,
} from './packFrontMatter';
import type { BoardPackInput } from './packBoardPackInput';
import { printedStrings } from './packPrintedStrings';
import type { PackComparativePeriod, PackPagesDocument } from './packPageModel';

/** The cover and the contents are sheets 1 and 2. */
const BODY_FIRST_SHEET = 3;

export function assembleBoardPackDocument(
  body: UnnumberedPage[],
  input: BoardPackInput,
  generatedAt: string,
  trend: PackTrendPoint[],
  scale: MoneyScale,
  currency: string,
  basis: PackBasis,
  comparativePeriod: PackComparativePeriod | null,
  draft: boolean,
  p: PackFigureProvenance,
): PackPagesDocument {
  // Page 2 says where the full basis is; it is the LAST page, counted rather
  // than written as the literal 12 it used to be. The basis page is not in
  // `body` yet — see below — so it is counted here.
  const total = 2 + body.length + 1;
  const [cover, contents] = buildFrontPages({
    companyLegalName: input.companyLegalName,
    period: input.period,
    preparedBy: input.preparedBy,
    generatedAt,
    draftReasons: input.draftReasons,
    partialMonth: partialMonthClauseFor(trend),
    scale,
    currency,
    basis,
    basisPageNumber: total,
  });
  // THE CONTENTS PAGE IS FITTED BEFORE THE BASIS PAGE IS COMPOSED, and the
  // order is the whole point. The caveats print with the contents now, and
  // the basis page's standfirst counts them and says where they are — a
  // count composed before the contents page is held to its sheet is a count
  // that fit can falsify. See `fitContentsPage`.
  // THE LABELS, not the count: the index wraps a long one onto a second line
  // and the reserve has to know. Page 12 is not composed yet — it is composed
  // FROM this fit — so it is named by its constant.
  const fittedContents = fitContentsPage(
    contents!, [cover!, contents!, ...body].map((p2) => p2.navLabel).concat(BASIS_NAV_LABEL));
  // AND HOW MANY BRIDGES THE COLOUR KEY IS ABOUT — counted off the composed
  // body rather than assumed, because page 8's cash bridge is refused where
  // there is nothing to bridge through and the demo pack draws one waterfall,
  // under a key reading "On the bridges".
  const bridgesDrawn = body
    .flatMap((p2) => p2.blocks)
    .filter((b) => b.kind === 'chart' && b.chart.kind === 'waterfall').length;
  // THE GLOSSARY IS DRIVEN BY WHAT THE ELEVEN SHEETS BEFORE IT PRINT — see
  // `definitionsPrintedBy`. Composed off the BODY, which is why it happens
  // here and not in `buildBasis`: the basis is built before a single page
  // exists, and a definition of a measure the document does not carry is a
  // definition of nothing.
  const printedProse = body
    .flatMap((p2) => printedStrings(p2))
    .join(' \u0001 ')
    .toLowerCase();
  const basisPage = buildBasisPage(
    { ...basis, definitions: definitionsPrintedBy(basis.definitions, printedProse) },
    input.companyLegalName, input.period, comparativePeriod, scale, currency,
    printedCaveats(fittedContents, basis), bridgesDrawn,
  );
  const pages = numbered([
    cover!,
    fittedContents,
    // EVERY page, held to its sheet — the same rule the matters table spends
    // its budget under, applied to the prose on the other eleven. A page that
    // already fits comes back untouched.
    //
    // LAYOUT FIRST, THEN THE FIT, both inside `fitBodyPage`. `relaidNarrative`
    // decides which of the narrative page's two shapes its block is drawn in —
    // see the module, and note that it drops nothing. It runs BEFORE
    // `fitPageToBox` because that function may take disclosure notes and page
    // footnotes and nothing else, and that list is the guarantee no figure is
    // ever trimmed off a sheet. `fitBodyPage` also words the refusal when it
    // is the approved commentary that does not fit.
    // `body[i]` is sheet i + 3: the cover and the contents come first.
    ...body.map((p2, i) => fitBodyPage(p2, i + BODY_FIRST_SHEET)),
    fitPageToBox(basisPage),
  ]);

  const document: PackPagesDocument = {
    packType: 'board',
    packLabel: PACK_LABELS.board,
    companyName: input.companyLegalName,
    period: input.period,
    generatedAt,
    draft,
    brand: input.brand,
    numberConvention: basis.numberConvention,
    basisOfPreparation: basis.basisOfPreparation,
    comparativePeriod,
    provenance: p,
    pages,
  };

  // Spec §7.2, and the last thing this function does: a pack whose figures do
  // not reconcile never becomes a document. The gate THROWS rather than
  // warning, because a warning on a pack a director forwards to their bank is
  // a warning nobody reads. Every caller of this function inherits it, which
  // is the only way the check cannot be forgotten at one call site.
  assertPackIntegrity(document);
  return document;
}
