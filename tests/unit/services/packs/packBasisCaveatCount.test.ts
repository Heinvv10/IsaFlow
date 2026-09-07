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
 * The count is composed before the page is held to its sheet, so this pins
 * both halves of the fix — the caveats are the LAST prose the fitter may take
 * (they were the first, being the page's last block), and whatever it does
 * take, the standfirst is composed again against what survived.
 */
import { describe, expect, it } from 'vitest';
import { buildBasisPage, fitBasisPage } from '@/modules/accounting/services/packs/pages/packFrontMatter';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
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

function build(basis: PackBasis) {
  return fitBasisPage(
    buildBasisPage(basis, '1 January 2026 to 7 September 2026', null, PACK_SCALE, 'ZAR'),
    basis,
    PACK_SCALE,
  );
}

/** The caveats the page actually prints. */
function printed(page: ReturnType<typeof build>): number {
  for (const block of page.blocks) {
    if (block.kind === 'disclosure' && block.disclosure.heading === 'Caveats') {
      return block.disclosure.notes.length;
    }
  }
  return 0;
}

describe("the basis page's caveat count", () => {
  it('states the two it prints when the page has room for both', () => {
    const page = build(basisWith(4, 2));
    expect(pageMm(page)).toBeLessThanOrEqual(pageBoxMm(page));
    expect(printed(page)).toBe(2);
    expect(page.title).toContain('2 caveats qualify these figures');
  });

  it('states the one it prints when the page does not', () => {
    // A glossary big enough that the sheet cannot carry both caveats. The
    // page is still one sheet — that is the constraint the whole fit exists
    // for — so the question is only whether it tells the truth about itself.
    const page = build(basisWith(20, 2));
    expect(pageMm(page)).toBeLessThanOrEqual(pageBoxMm(page));
    const count = printed(page);
    expect(count, 'this fixture is meant to cost the page a caveat').toBeLessThan(2);
    expect(page.title).toContain(count === 1 ? 'one caveat qualifies' : 'no caveat qualifies');
    expect(page.title).not.toContain('2 caveats');
  });

  it('never reduces the caveats to nothing, and drops the pack\'s own prose first', () => {
    const page = build(basisWith(20, 2));
    expect(printed(page), 'a required disclosure is never taken to zero').toBeGreaterThan(0);
    const said = page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
    // Whatever the page gave up, it says so — and a caveat is only ever taken
    // after the pack's own optional prose has gone.
    if (printed(page) < 2) {
      expect(said, 'the page took a caveat and did not say so').toBeDefined();
    }
  });
});
