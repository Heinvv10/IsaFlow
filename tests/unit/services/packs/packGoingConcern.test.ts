/**
 * THE PACK RAISED GOING CONCERN AND STATED NO BASIS FOR IT.
 *
 * Page 7 tells both companies that liabilities exceeding assets "may affect
 * covenant compliance and the going-concern assessment" — on negative equity
 * of (4 087) and (2 176) — and no sheet of either pack then said what basis
 * the figures were prepared on. For an entity in that position it is the one
 * basis element a director looks for and does not find. The clean-room gate
 * was explicit that criterion 11 did not fail on it, because the elements
 * that criterion names — reporting entity and consolidation — are both
 * present and explicit: this is a gap in the accounting rather than in the
 * rubric.
 *
 * IT SAYS THERE IS NONE RATHER THAN ASSERTING ONE. A going-concern basis is a
 * judgement about the twelve months after the reporting date — funding,
 * forecasts, undertakings — and nothing in this ledger carries any of it.
 * "Prepared on the going-concern basis" would be the pack vouching for a
 * conclusion it has no evidence of, on the two companies where the conclusion
 * is least safe.
 *
 * AND IT IS UNCONDITIONAL. Two ways of getting this wrong are worse than not
 * having it: printing it on the packs where a sheet has room and not on the
 * others, which is the asymmetry class this branch has spent itself closing;
 * and printing it only where the figures look alarming, which would make the
 * sentence's PRESENCE a signal about the company. So it prints on every pack
 * and every shape, in one place, whatever the ledger says.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { GOING_CONCERN_NOTE } from '@/modules/accounting/services/packs/pages/packFrontMatter';
import {
  brightsphereInput,
  brightsphereLiveInput,
  brightsphereReceivablesGapInput,
  demoInput,
  denseInput,
  noRatioPanelsInput,
} from './fixtures/boardPackInputs';
import {
  liveDemoBridgeInput,
  liveDemoInput,
  liveDemoShortPanelsInput,
  manyLongNullQuantumMattersInput,
  manyShortNullQuantumMattersInput,
  millionsCashInput,
} from './fixtures/liveDemoBoardPack';
import type { PackPage, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

/**
 * EVERY SHAPE THE SUITE CARRIES, not the two companies. A basis element that
 * is present on the packs with room and absent on the tight ones is the
 * defect, not the fix — and page 12 could not carry this on the
 * EBITDA-rounding shape, which is exactly why it is not on page 12.
 */
const FIXTURES: Record<string, BoardPackInput> = {
  demo: demoInput,
  brightsphere: brightsphereInput,
  dense: denseInput,
  'no ratio panels': noRatioPanelsInput,
  live: liveDemoInput,
  'live, short panels': liveDemoShortPanelsInput,
  'live, the EBITDA bridge that rounds': liveDemoBridgeInput,
  'Brightsphere as the live route composed it': brightsphereLiveInput,
  'Brightsphere with the receivables gap': brightsphereReceivablesGapInput,
  'many long null-quantum matters': manyLongNullQuantumMattersInput,
  'many short null-quantum matters': manyShortNullQuantumMattersInput,
  'cash in the millions': millionsCashInput,
};

/** Every note the document prints, as `page → heading → body`. */
function notes(doc: PackPagesDocument): Array<{ page: number; heading: string; body: string }> {
  return doc.pages.flatMap((page: PackPage) => page.blocks.flatMap((b) => (b.kind === 'disclosure'
    ? b.disclosure.notes.map((n) => ({ page: page.number, heading: n.heading, body: n.body }))
    : [])));
}

describe('the pack states the basis it was prepared on, or says it states none', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`states a going-concern position on ${name}`, () => {
      const found = notes(buildBoardPackPages(input))
        .filter((n) => n.body === GOING_CONCERN_NOTE);
      expect(found.length, `${name} states no going-concern position anywhere`).toBe(1);
      // ONE PLACE, THE SAME PLACE. Page 2 is titled "The basis, in short" —
      // a basis sheet by its own name, and the sheet a director reads before
      // the numbers.
      expect(found[0]!.page, `${name} states it somewhere other than page 2`).toBe(2);
      expect(found[0]!.heading).toBe('Going concern');
    });
  }

  it('says the pack states none, and asserts no basis it cannot support', () => {
    // The WORDING, not merely a sentence with "going concern" in it. A pack
    // that printed "prepared on the going-concern basis" would satisfy a test
    // for the term's presence while vouching for a judgement about the next
    // twelve months that nothing in the ledger carries.
    expect(GOING_CONCERN_NOTE).toBe(
      'This pack states no going-concern basis; the assessment is a matter for the board.',
    );
    for (const [name, input] of Object.entries(FIXTURES)) {
      const said = notes(buildBoardPackPages(input))
        .map((n) => n.body.toLowerCase())
        .filter((b) => b.includes('going-concern') || b.includes('going concern'));
      for (const sentence of said) {
        expect(sentence, `${name} asserts a going-concern basis: ${sentence}`)
          .not.toMatch(/prepared on (a|the) going.concern basis/);
      }
    }
  });

  it('is not conditional on the figures looking alarming', () => {
    // Both live companies are in negative equity and both raise the phrase on
    // page 7. If the statement only appeared for them, its PRESENCE would be
    // the signal rather than its content — and a reader of a healthy pack
    // would have no way to tell a pack that states no basis from one that
    // does. `demoInput` and `denseInput` are the shapes that carry it without
    // the page 7 sentence behind it.
    const raises = (input: BoardPackInput): boolean => notes(buildBoardPackPages(input))
      .some((n) => /going.concern assessment/i.test(n.body));
    const withWarning = Object.entries(FIXTURES).filter(([, i]) => raises(i));
    const without = Object.entries(FIXTURES).filter(([, i]) => !raises(i));
    expect(withWarning.length, 'no fixture raises going concern on page 7').toBeGreaterThan(0);
    expect(without.length, 'every fixture raises it, so the unconditional claim is untested')
      .toBeGreaterThan(0);
    for (const [name, input] of [...withWarning, ...without]) {
      expect(
        notes(buildBoardPackPages(input)).filter((n) => n.body === GOING_CONCERN_NOTE).length,
        `${name} does not state a going-concern position`,
      ).toBe(1);
    }
  });

  /**
   * A BASIS STATED ACROSS TWO SHEETS SAYS SO ON THE SHEET IT IS STATED ON.
   *
   * The going-concern line is on page 2 and the other eight basis facts are
   * on page 12 — and a basis split across two sheets where neither names the
   * other is the cross-reference defect this branch has fixed six times. It
   * is not that here: the note sits in "The basis, in short", one line under
   * the note that ends "Full basis on page 12", so a reader who meets the
   * going-concern statement is told in the same block where the rest of the
   * basis lives.
   *
   * THE OTHER DIRECTION IS NOT PRINTED, and that is measured rather than
   * forgotten. Page 12 has 2.6mm of paper spare on the shape whose EBITDA
   * bridge does not add as printed, and the cheapest cross-reference that
   * block can carry costs 4.2mm — one line, whichever note it is appended to
   * and whether it goes in the title, the standard-and-currency fact or the
   * ledger version. A pointer that printed on eleven shapes and not the
   * twelfth would be the per-shape variance the going-concern line itself was
   * moved here to avoid.
   */
  it('names where the rest of the basis is, in the block that carries it', () => {
    for (const [name, input] of Object.entries(FIXTURES)) {
      const doc = buildBoardPackPages(input);
      const block = doc.pages[1]!.blocks.find((b) => b.kind === 'disclosure'
        && b.disclosure.notes.some((n) => n.body === GOING_CONCERN_NOTE));
      expect(block, `${name}: page 2 carries no block with the going-concern note in it`)
        .toBeDefined();
      const bodies = block!.kind === 'disclosure' ? block!.disclosure.notes.map((n) => n.body) : [];
      expect(
        bodies.some((b) => b.includes(`Full basis on page ${doc.pages.length}`)),
        `${name}: the going-concern note is stranded — its block does not say where the rest of `
          + `the basis is: ${bodies.join(' / ')}`,
      ).toBe(true);
    }
  });

  it('costs no sheet its own prose', () => {
    // It is on page 2 because page 12 has 0.0mm spare on the EBITDA-rounding
    // shape and this fact needs 4.2mm of it — buyable only by dropping the
    // Colour key, which is the pack's reading key for its own bridges. A
    // disclosure bought by dropping a disclosure is a swap, not a gain, so
    // the sheet it landed on must give up nothing either.
    for (const [name, input] of Object.entries(FIXTURES)) {
      const doc = buildBoardPackPages(input);
      expect(doc.pages, `${name} is not twelve sheets`).toHaveLength(12);
      const dropped = doc.pages
        .filter((p) => p.footnotes.some((f) => f.text.startsWith('Not printed on this page')))
        .map((p) => p.number);
      expect(dropped, `${name} pays for the going-concern line out of another sheet's prose`)
        .toEqual([]);
    }
  });
});
