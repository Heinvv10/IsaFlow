/**
 * A SIGNED COMMENTARY MUST NOT REFUSE THE PACK.
 *
 * `buildBoardPackPages` threw `PackRefusal` for ANY non-empty approved
 * commentary on the live demo company — a six-word body and a twenty-sentence
 * body both produced `"Commentary and actions" needs 288.7mm and its sheet
 * gives 255mm` — and the company got no document at all. Nothing in this
 * codebase stores board commentary yet, so every fixture carried
 * `commentary: null` and no test in ~10 000 saw it. It would have arrived
 * with the feature, on a tenant, with no fixture to reproduce it from.
 *
 * THE COMMENTARY WAS NOT THE CAUSE. `.pack-narrative-columns` is `2fr 1fr`
 * for an approved narrative and one full-measure column for a pending one, so
 * approving commentary moved the DERIVED action panel — which has nothing to
 * do with the commentary, and comes from the matters model — out of 174mm of
 * measure and into 43mm. The live demo company's three actions cost 75.1mm at
 * the first and 183.2mm at the second. `fitPageToBox` may take disclosure
 * notes and page footnotes and nothing else, so there was no lever on the
 * block that had grown, and the page was refused.
 *
 * The block now takes the shorter of the two layouts the stylesheet already
 * draws, and drops nothing to do it. These hold both halves: the pack
 * composes, and the panel is not squeezed to buy it.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { narrativeMm } from '@/modules/accounting/services/packs/pages/packBlockHeights';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import {
  liveDemoApprovedCommentaryInput,
  liveDemoOverlongCommentaryInput,
  liveDemoShortPanelsInput,
} from './fixtures/liveDemoBoardPack';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

const commentaryPage = (input: Parameters<typeof buildBoardPackPages>[0]): PackPage =>
  buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Commentary and actions')!;

/** The block, and the two lists on it, off the composed page. */
function narrativeBlock(page: PackPage) {
  const block = page.blocks.find((b) => b.kind === 'narrative');
  if (block?.kind !== 'narrative') throw new Error('page 4 carries no narrative block');
  return block;
}

describe('a pack whose commentary a human signed', () => {
  it('composes twelve sheets, where every one of them used to be refused', () => {
    const doc = buildBoardPackPages(liveDemoApprovedCommentaryInput);
    expect(doc.pages).toHaveLength(12);
    const page = commentaryPage(liveDemoApprovedCommentaryInput);
    expect(pageMm(page), 'page 4 is past its sheet').toBeLessThanOrEqual(pageBoxMm(page));
  });

  it('prints the signed prose and the derived panel, neither at the other’s expense', () => {
    const block = narrativeBlock(commentaryPage(liveDemoApprovedCommentaryInput));
    expect(block.narrative.status).toBe('approved');
    expect(block.narrative.body).toContain('the margin recovery is a mix effect');
    // THE APPROVER'S OWN ACTION ITEM, which is not the derived panel.
    expect(block.narrative.actions).toEqual(
      ['Approve the revised facility limit before the November draw.'],
    );
    // AND EVERY DERIVED ACTION THE PENDING PACK CARRIED. The fix must not be
    // "print fewer of them": the whole objection to a cap is that it decides
    // what page 4 gives up, and this gives up nothing.
    const pending = narrativeBlock(commentaryPage(liveDemoShortPanelsInput));
    expect(block.boardActions).toEqual(pending.boardActions);
    expect(block.boardActionsTail).toEqual(pending.boardActionsTail);
    expect((block.boardActions ?? []).length, 'no derived actions, so nothing is being checked')
      .toBeGreaterThan(1);
  });

  it('stacks the panel rather than squeezing it into a third of the measure', () => {
    const block = narrativeBlock(commentaryPage(liveDemoApprovedCommentaryInput));
    expect(block.stackActions, 'the composed block is still drawn in two columns').toBe(true);
    // The two measurements this is between, on this company's own actions:
    // the side-by-side layout is the one that refused the pack.
    const actions = block.boardActions ?? [];
    const tail = block.boardActionsTail ?? [];
    const columns = narrativeMm(block.narrative, actions, 'portrait', tail, false);
    const stacked = narrativeMm(block.narrative, actions, 'portrait', tail, true);
    expect(columns, 'the narrow-column layout is not the tall one any more').toBeGreaterThan(180);
    expect(stacked).toBeLessThan(columns);
  });

  /**
   * AND IT IS PULLED BEFORE ANYTHING IS GIVEN UP.
   *
   * Stacking costs the reader nothing, so a page that fits once stacked must
   * lose no prose at all. Order the levers the other way — take the optional
   * notes first, stack only when they run out — and this page still fits and
   * still prints twelve sheets, having thrown away two explanations of its
   * own figures to buy room it did not need. That mutation is invisible to a
   * sheet count and to every assertion above it.
   */
  it('gives up no prose to fit, because stacking costs the reader nothing', () => {
    const approved = commentaryPage(liveDemoApprovedCommentaryInput);
    expect(approved.footnotes.filter((f) => f.text.startsWith(OMISSION_MARK)))
      .toEqual([]);
    // EVERY disclosure the same pack prints with its commentary unsigned.
    // Signing the commentary must not cost the page an explanation.
    const headings = (page: PackPage): string[] => page.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? [b.disclosure.heading] : []));
    const pending = commentaryPage(liveDemoShortPanelsInput);
    expect(headings(pending).length, 'page 4 carries no disclosures, so nothing can be lost')
      .toBeGreaterThan(1);
    expect(headings(approved)).toEqual(headings(pending));
    // And their notes are whole, not abridged.
    const notes = (page: PackPage): number[] => page.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? [b.disclosure.notes.length] : []));
    expect(notes(approved)).toEqual(notes(pending));
  });

  it('leaves a pack whose commentary is still pending exactly as it was', () => {
    // The control. A fix that restacked every narrative block would satisfy
    // everything above and change eleven sheets nobody asked it to.
    const before = commentaryPage(liveDemoShortPanelsInput);
    expect(pageMm(before)).toBeCloseTo(218.2, 1);
    const block = narrativeBlock(before);
    expect(block.narrative.status).toBe('pending');
    // AND IT WAS NEVER RESTACKED, because it never had to be: a pending
    // narrative already draws in one column and the page fits as composed.
    expect(block.stackActions).toBeUndefined();
  });

  /**
   * AND THE BOUND, MEASURED RATHER THAN ASSUMED.
   *
   * Thirty paragraphs — some four thousand words on one sheet — still
   * refuses, and that is the pack's designed behaviour: a page whose
   * remaining prose is all required is refused rather than printed across two
   * sheets under a contents page that indexes one. The fix is that a
   * commentary a person would write composes, not that none can be too long.
   * Asserting only the first half would pass a build that composed anything
   * by silently dropping it.
   */
  it('still refuses a commentary nobody would write, and says which page', () => {
    let refusal: PackRefusal | null = null;
    try {
      buildBoardPackPages(liveDemoOverlongCommentaryInput);
    } catch (error) {
      refusal = error instanceof PackRefusal ? error : null;
      if (refusal === null) throw error;
    }
    expect(refusal, 'a four-thousand-word commentary composed a twelve-sheet pack').not.toBeNull();
    expect(refusal!.message).toContain('Commentary and actions');
  });
});
