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
import { relaidNarrative } from '@/modules/accounting/services/packs/pages/packNarrativeLayout';
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

/**
 * THE TRIGGER ITSELF, PINNED.
 *
 * The composed assertions above go red if the fallback disappears, but they
 * go red as a REFUSAL — an exception with a millimetre count in it — which
 * is a confusing way to learn that a layout rule was deleted. These hold the
 * rule directly: when it fires, when it does not, and that firing costs the
 * page nothing.
 */
describe('the layout decision page 4 makes before it is held to its sheet', () => {
  const NOTE = { heading: 'Reading this page', body: 'The prior column is the comparative period '
    + 'the basis page states, and a movement is never shown as a move from zero.' };

  const page = (blocks: PackPage['blocks']): PackPage => ({
    number: 4,
    title: 'Three matters need a decision this period.',
    navLabel: 'Commentary and actions',
    section: 'Commentary',
    orientation: 'portrait',
    density: 'high',
    blocks,
    footnotes: [],
  });

  const narrative = (actions: string[]): PackPage['blocks'][number] => ({
    kind: 'narrative',
    narrative: { status: 'approved', body: 'Trading held up.', actions: [] },
    boardActions: actions,
  });

  /** Enough derived actions, at enough length, that a third of the measure
   *  cannot hold them — the shape that refused the pack. */
  const CROWDED = Array.from({ length: 7 }, (unused, i) =>
    `Annual Financial Statements for FY202${i} is overdue and the board should record who is `
    + 'accountable for the filing, the date by which it will be lodged, and what the exposure is '
    + 'if it is not.');

  it('stacks a page the two-column layout puts past its sheet', () => {
    const subject = page([narrative(CROWDED)]);
    expect(pageMm(subject), 'the fixture fits as composed, so the rule is not being tested')
      .toBeGreaterThan(pageBoxMm(subject));
    const relaid = relaidNarrative(subject);
    const block = relaid.blocks[0]!;
    expect(block.kind === 'narrative' && block.stackActions).toBe(true);
    expect(pageMm(relaid)).toBeLessThanOrEqual(pageBoxMm(relaid));
  });

  it('gives up nothing to do it — same blocks, same actions, same footnotes', () => {
    const subject = page([narrative(CROWDED), { kind: 'disclosure', disclosure: {
      heading: 'How this page is prepared', notes: [NOTE, NOTE] } }]);
    const relaid = relaidNarrative(subject);
    expect(relaid.blocks).toHaveLength(subject.blocks.length);
    expect(relaid.footnotes).toEqual(subject.footnotes);
    const before = subject.blocks[0]!;
    const after = relaid.blocks[0]!;
    expect(after.kind === 'narrative' && after.boardActions)
      .toEqual(before.kind === 'narrative' && before.boardActions);
    // The disclosure beside it is untouched: this is not a trim, and the
    // fitter's list of what it may take is unchanged by it.
    expect(relaid.blocks[1]).toBe(subject.blocks[1]);
  });

  it('leaves a page that already fits exactly as it was, object and all', () => {
    const subject = page([narrative([CROWDED[0]!])]);
    expect(pageMm(subject)).toBeLessThanOrEqual(pageBoxMm(subject));
    expect(relaidNarrative(subject)).toBe(subject);
  });

  it('leaves an over-full page with nothing to restack to the fitter', () => {
    const subject = page([{ kind: 'disclosure', disclosure: {
      heading: 'How this page is prepared', notes: Array.from({ length: 40 }, () => NOTE) } }]);
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));
    expect(relaidNarrative(subject)).toBe(subject);
  });

  /**
   * AND IT DOES NOT MAKE A PAGE WORSE TO OBEY ITSELF.
   *
   * Stacking is the shorter shape for every panel these packs produce, but it
   * is not shorter by arithmetic: the two-column row costs the TALLER of its
   * columns and the stacked one costs their SUM, so where the prose and the
   * panel are of a size — three derived actions against eleven paragraphs
   * here — the fallback would add millimetres to a page that is already over. It stays in columns
   * and the fitter deals with the page as composed, which is the right answer:
   * the two-column layout is the one page 4 was designed around.
   */
  it('leaves the page in columns where stacking would be the taller shape', () => {
    const body = ('Trading held up in the second half and the margin recovery is a mix effect '
      + 'rather than a pricing gain. ').repeat(11);
    const balanced: PackPage['blocks'][number] = {
      kind: 'narrative',
      narrative: { status: 'approved', body, actions: [] },
      boardActions: Array.from({ length: 3 }, (unused, i) =>
        `Annual Financial Statements for FY202${i} is overdue and the board should record who is `
        + 'accountable.'),
    };
    const filler: PackPage['blocks'][number] = { kind: 'disclosure', disclosure: {
      heading: 'How this page is prepared', notes: Array.from({ length: 20 }, () => NOTE) } };
    const subject = page([balanced, filler]);
    // The premise, both halves: the page is over, AND stacking would be worse.
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));
    const stackedBlock = { ...balanced, stackActions: true };
    expect(pageMm(page([stackedBlock, filler])), 'stacking is not the taller shape here')
      .toBeGreaterThan(pageMm(subject));
    expect(relaidNarrative(subject)).toBe(subject);
  });

  it('leaves a narrative with no derived panel alone — there is nothing to stack', () => {
    const subject = page([narrative([]), { kind: 'disclosure', disclosure: {
      heading: 'How this page is prepared', notes: Array.from({ length: 40 }, () => NOTE) } }]);
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));
    expect(relaidNarrative(subject)).toBe(subject);
  });
});
