/**
 * THE GOVERNANCE PAGE MUST NOT MISCOUNT ITS OWN QUALIFICATIONS.
 *
 * The rendered pack's standfirst read "…in R'000; 2 caveats qualify these
 * figures", the page printed one, and its own footer then admitted
 * "Not printed on this page: 1 explanatory note, from 'Caveats'". That is not
 * a layout complaint: it is the page telling a director there is a second
 * qualification of the figures and then not saying what it is, on the one
 * sheet whose whole job is to say how the numbers were made.
 *
 * THE CAVEATS NOW PRINT WITH THE CONTENTS, and the invariant travels with
 * them. Page 12 was composing within two millimetres of its box on a live
 * ledger with no room left for the colour key it owed the reader, and page 2
 * was a twelve-line index over 60% white; a qualification of the figures is
 * also the thing a director should meet before the figures rather than after
 * the glossary. So the count the basis page states is a count of what the
 * CONTENTS page printed — composed before that page is held to its sheet, so
 * the caller fits the contents page first and hands the survivors on.
 *
 * Both halves of the original fix still hold: the caveats are a REQUIRED
 * disclosure, so the fitter reaches them only after the page's own optional
 * prose and never takes the first; and whatever it does take, the standfirst
 * counts what survived.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBasisPage, buildFrontPages, contentsListMm, fitContentsPage, printedCaveats,
} from '@/modules/accounting/services/packs/pages/packFrontMatter';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { fitPageToBox } from '@/modules/accounting/services/packs/pages/packPageFit';
import type { UnnumberedPage } from '@/modules/accounting/services/packs/pages/packFrontMatter';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import type { PackBasis } from '@/modules/accounting/services/packs/pages/packBasis';

/** A caveat long enough that two of them cannot both fit beside a glossary
 *  sized to fill the sheet. */
const CAVEAT = (n: number): string =>
  `Caveat ${n}: stock is carried in an account whose subtype is not set to inventory, so the `
  + 'inventory figure this pack states is the balance of that account rather than a costed count, '
  + 'and every ratio derived from it inherits that assumption for the whole of the period.';

function basisWith(definitions: number, caveats: number): PackBasis {
  return {
    basisOfPreparation: {
      standard: 'IFRS for SMEs',
      sourceSystem: 'IsaFlow general ledger',
      extractedAt: '7 September 2026 at 13:09 SAST',
      ledgerVersion: '7 September 2026 at 12:39 SAST',
    },
    numberConvention: { scale: PACK_SCALE, currency: 'ZAR' },
    definitions: Array.from({ length: definitions }, (_, i) => ({
      term: `Measure ${i + 1}`,
      definition: 'A measure of the period, defined at length so that the glossary occupies the '
        + 'paper a real one does and the page has to choose what else it can carry.',
    })),
    caveats: Array.from({ length: caveats }, (_, i) => CAVEAT(i + 1)),
  };
}

/** The two pages the caveats are split across: the contents page prints
 *  them, the basis page counts them. Composed in the order
 *  `buildBoardPackPages` composes them. */
function build(basis: PackBasis) {
  const [, contents] = buildFrontPages({
    companyLegalName: 'Fixture (Pty) Ltd',
    period: '1 January 2026 to 7 September 2026',
    preparedBy: 'A Person',
    generatedAt: '2026-09-07T06:00:00.000Z',
    draftReasons: [],
    scale: PACK_SCALE,
    currency: 'ZAR',
    basis,
    basisPageNumber: 12,
  });
  const fittedContents = fitContentsPage(contents!, NAV_LABELS);
  return {
    contents: fittedContents,
    listMm: contentsListMm(NAV_LABELS),
    basisPage: fitPageToBox(buildBasisPage(
      basis, 'Fixture (Pty) Ltd', '1 January 2026 to 7 September 2026', null, PACK_SCALE, 'ZAR',
      printedCaveats(fittedContents, basis),
    )),
  };
}

/** How many caveats a composed page actually printed. The `basis` argument
 *  only tells `printedCaveats` that the pack HAS caveats, so any non-empty
 *  one answers the question. */
function printedOn(page: UnnumberedPage): number {
  return printedCaveats(page, basisWith(0, 1));
}

/** The twelve names the board pack's index prints, as `buildBoardPackPages`
 *  composes them. The reserve is measured off the LABELS — a long one wraps
 *  and costs the sheet a line — so the strings are what this fixture carries
 *  rather than a count. */
const NAV_LABELS = [
  'Cover', 'Contents', 'Highlights', 'Commentary and actions', 'Monthly results',
  'Income statement', 'Balance sheet', 'Cash', 'Scorecard', 'Trends',
  'Matters for the board', 'Basis of preparation',
];

/** More long caveats than a contents sheet can hold beside its index. */
const MANY_CAVEATS = 12;

describe("the basis page's caveat count", () => {
  it('states the two the contents page prints when there is room for both', () => {
    const { contents, basisPage } = build(basisWith(4, 2));
    expect(pageMm(contents) + contentsListMm(NAV_LABELS)).toBeLessThanOrEqual(pageBoxMm(contents));
    expect(pageMm(basisPage)).toBeLessThanOrEqual(pageBoxMm(basisPage));
    expect(printedOn(contents)).toBe(2);
    expect(basisPage.title).toContain('2 caveats qualify these figures, printed with the contents');
    // And the basis page does not print them a second time.
    expect(basisPage.blocks.some((b) => b.kind === 'disclosure' && b.disclosure.heading === 'Caveats'))
      .toBe(false);
  });

  it('states the ones it prints when the contents page cannot carry them all', () => {
    // Enough long caveats that the contents sheet cannot hold them beside the
    // index. The pack is still twelve sheets — that is the constraint the
    // whole fit exists for — so the question is only whether the basis page
    // tells the truth about what a reader can turn to.
    const { contents, basisPage } = build(basisWith(4, MANY_CAVEATS));
    // THE INDEX COUNTS. `PackContents` draws it off the page list rather than
    // out of a block, so a page held only to `pageMm` would run onto a
    // thirteenth sheet under an index that says twelve.
    expect(pageMm(contents) + contentsListMm(NAV_LABELS)).toBeLessThanOrEqual(pageBoxMm(contents));
    const count = printedOn(contents);
    expect(count, 'this fixture is meant to cost the page a caveat').toBeLessThan(MANY_CAVEATS);
    expect(basisPage.title).toContain(count === 1 ? 'one caveat qualifies' : `${count} caveats qualify`);
    expect(basisPage.title).not.toContain(`${MANY_CAVEATS} caveats`);
  });

  it('never reduces the caveats to nothing, and says on the page what it took', () => {
    const { contents } = build(basisWith(4, MANY_CAVEATS));
    expect(printedOn(contents), 'a required disclosure is never taken to zero').toBeGreaterThan(0);
    const said = contents.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
    if (printedOn(contents) < MANY_CAVEATS) {
      expect(said, 'the contents page took a caveat and did not say so').toBeDefined();
    }
  });
});

/**
 * THE INDEX IS MEASURED OFF ITS LABELS, NOT OFF A COUNT.
 *
 * `contentsListMm` assumed one line per entry and never saw the strings. The
 * board pack's twelve labels are short enough that the assumption held; an
 * eighteen-page management pack with longer ones is the next document on
 * these primitives, and a wrapped label makes the reserve UNDER-read — the
 * one direction that puts a page on a thirteenth sheet under an index saying
 * twelve.
 */
describe('the contents reserve measures the labels it will print', () => {
  it('charges a label that wraps for the second line it takes', () => {
    const short = contentsListMm(['Cash']);
    const wrapped = contentsListMm([
      'Cash, and the bridge between the opening and closing balances that this '
      + 'pack does not carry the operating, investing and financing figures to draw',
    ]);
    // One 16pt line of the contents list is 5.6mm. A count-times-a-row model
    // returns the same number for both of these.
    expect(wrapped - short).toBeGreaterThan(5);
  });

  it('does not inflate the twelve the board pack actually prints', () => {
    // The other direction: every real label fits one line, so the reserve is
    // the twelve rows the sheet draws and not a pessimistic multiple of them.
    const oneLineEach = contentsListMm(['Cash']) + 11 * (contentsListMm(['Cash', 'Cash']) - contentsListMm(['Cash']));
    expect(contentsListMm(NAV_LABELS)).toBeCloseTo(oneLineEach, 5);
  });
});
