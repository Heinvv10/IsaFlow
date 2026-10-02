/**
 * The last page — the basis of preparation, the glossary and the pack's one
 * colour key — with its standfirst and its name in the index. Split out of
 * `packFrontMatter.ts` for the 300-line cap; that file re-exports
 * `buildBasisPage` and `BASIS_NAV_LABEL`, so every caller still imports
 * them there.
 */
import { ROUNDING_NOTE } from './packBasis';
import { disclose, note } from './packPageBlocks';
import { page, type UnnumberedPage } from './packUnnumberedPage';
import type { PackBasis } from './packBasis';
import type { MoneyScale } from '@/lib/format/money';
import type { PackComparativePeriod } from './packPageModel';

/**
 * The one palette, in the fewest words that still name all three systems.
 *
 * Short because page 12 is the tightest sheet in the pack — on the live
 * Brightsphere ledger it composes within about two millimetres of its box,
 * and `fitPageToBox` pays for a long note by taking the ledger version and
 * the extraction time off the fact list above it. A colour key is not worth
 * the pack's own provenance.
 */
/**
 * ONE BRIDGE OR TWO, AND THE SENTENCE COUNTS THEM.
 *
 * "On the bridges" printed on a pack that draws one: the demo company's cash
 * bridge is refused — there is nothing to bridge THROUGH, and page 8 says so
 * in prose — so its only waterfall is the profit bridge on sheet 6. A key
 * that pluralises a chart a reader can count is the pack telling them to look
 * for a second one.
 */
const colourKey = (bridges: number): string =>
  `On the ${bridges === 1 ? 'bridge' : 'bridges'}, green is an income line, red a cost line and dark ink a total; `
  // "THE TWO" AFTER A LIST OF THREE. The sentence enumerates green, red and
  // dark ink and then guarantees the greyscale separation for a pair with no
  // antecedent — understating a fact the pack can state in full. Measured off
  // the vector at 400dpi: green 137, red 80, ink 36, all three separate.
  + 'all three also differ in lightness, so a monochrome copy still separates them. '
  + 'The balance sheet\'s bands are one ink at three lightnesses, legended on the chart. '
  + 'Red on the scorecard marks a missed target.';

/** The last page — spec §4.A page 12. */
export function buildBasisPage(
  basis: PackBasis,
  /** The legal name on the cover — page 12's `Reporting entity` fact. Taken
   *  as a value rather than off `PackBasis`, because `buildBasis` composes
   *  from the FIGURES and the company's name is not one of them. */
  companyName: string,
  period: string,
  comparativePeriod: PackComparativePeriod | null,
  scale: MoneyScale,
  currency: string,
  /** The caveats the CONTENTS page composed — see `printedCaveats`. Passed in
   *  rather than read off `basis`, because this sentence must count what a
   *  reader can actually turn to, and the contents page is held to its sheet
   *  like every other. */
  caveatsPrinted: number,
  /**
   * How many WATERFALL charts this pack actually draws — see `colourKey`.
   * The demo company's cash bridge is refused, so its pack has one and the
   * key pluralised it. Counted off the composed pages rather than assumed,
   * because whether the cash bridge is drawn is a decision made from the
   * figures.
   */
  bridgesDrawn = 2,
): UnnumberedPage {
  // A CONCLUSION, not the page's own name restated. It read "Basis of
  // preparation" over "Basis of preparation and definitions"; what a director
  // needs from the headline is what standard the figures were prepared under,
  // at what scale, and whether anything qualifies them.
  const title = basisTitle(basis, scale, caveatsPrinted);
  return page(title, BASIS_NAV_LABEL, 'Governance', 'medium', [
    disclose('Basis of preparation', [
      // THE STANDARD AND THE UNIT, IN ONE FACT.
      //
      // Two one-line facts saying eleven and twenty-two characters each, in
      // an 83mm column: `Standard` printed "IFRS for SMEs" and left two
      // thirds of its line white, and `Currency and rounding` printed
      // "ZAR, figures in R'000." beside it. Both facts survive verbatim; what
      // goes is a line of paper, and `Reporting entity` below is what it
      // buys. See `ROUNDING_NOTE` for the second line this page bought the
      // same way.
      note('Standard and currency', `${basis.basisOfPreparation.standard}. ${currency} in ${scale}.`),
      // THE PACK NAMES THE ENTITY IT REPORTS ON, AND SAYS WHAT IT DID NOT
      // CONSOLIDATE INTO IT.
      //
      // Page 12 named a standard, a period, a comparative, a currency, a
      // rounding rule, a source system, an extraction time and a ledger
      // version — and never the reporting entity. Sheet 5 was meanwhile
      // headed "Group results" (see `MONTHLY_RESULTS_NAV_LABEL`), so the pack
      // asserted a boundary in a header over a basis page that neither
      // confirmed nor denied one. Renaming the sheet removes the assertion;
      // it does not make the basis complete, because a basis of preparation
      // that does not say what entity it reports on is incomplete whatever
      // the sheets are called. Both halves are fixed, and this is the half
      // that is a fact rather than a name.
      //
      // IT IS A FACT THE PACK ALREADY HAS. `companyName` is the legal name on
      // the cover, and `buildBoardPackDocument` reads one company's ledger for
      // one `company_id` — there is no consolidation step anywhere in this
      // module — so "alone" and "not consolidated" are statements about how
      // the document was built, not a policy asserted on the company's behalf.
      note('Reporting entity', `${companyName} alone. These figures are not consolidated.`),
      // AND WHICH PART OF IT THE MONTHLY SERIES DOES NOT COVER IN FULL. The
      // series runs to the month CONTAINING the reporting date, so on a pack
      // run mid-month its last point is a stub — and page 10 quoted one as a
      // gross margin of 100.0%. See `partialMonthBasisNote`.
      note('Period', basis.partialMonth === null ? period : `${period}. ${basis.partialMonth}`),
      note('Comparative period', comparativePeriod === null
        ? 'None. There is no prior period with a ledger to compare against, so no statement carries a comparative column.'
        : comparativePeriod.label),
      note('Source system', basis.basisOfPreparation.sourceSystem),
      // SIXTH, AND THAT IS MEASURED RATHER THAN AESTHETIC. This is the only
      // multi-line fact in the block, and `balancedLines` splits the list
      // IN ORDER: with the long note here the two columns come out level on
      // every fixture, and moving it costs the page a line it does not have.
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
    disclose('Colour', [note('Key', colourKey(bridgesDrawn))]),
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

/** The name page 12 goes by in the index. A constant because the contents
 *  page is measured before that page is composed — see `contentsListMm`. */
export const BASIS_NAV_LABEL = 'Basis of preparation';
