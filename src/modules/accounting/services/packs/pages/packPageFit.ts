/**
 * A PAGE THAT DOES NOT FIT DROPS CONTENT AND SAYS SO. It never starts a
 * second sheet.
 *
 * The board pack is twelve sheets — the contents page indexes twelve items,
 * every footer counts `n / 12`, and the matters page tells a director in so
 * many words that a board pack is the same twelve sheets for every company.
 * Three times now a block that grows with data has outgrown its box and
 * quietly taken a thirteenth: fifteen matters rows, then the scorecard's
 * cross-reference footnote (two lines of grey 7.5pt alone on an untitled
 * sheet, under a note reading "on this page"), then the trends page's
 * "Panels not drawn" explanation, on a different company. Each was fixed
 * where it was found; the next one came from somewhere the fixture did not
 * model.
 *
 * So the composer stops guessing. `packPageMetrics` says how tall the page
 * will be, `pageBoxMm` says how tall the sheet is, and this decides what
 * comes off when the first exceeds the second.
 *
 * WHAT COMES OFF, IN ORDER. Nothing that carries a figure is ever a
 * candidate: no table, chart, tile, scorecard or matters row is trimmed here
 * (page 11's table has its own budget, spent before the page is built). What
 * is trimmed is the pack's prose ABOUT the page, cheapest first:
 *
 *   1. the trailing notes of a disclosure the pack does not have to make;
 *   2. page footnotes, last first;
 *   3. the trailing notes of a REQUIRED disclosure, never its first — §3.5's
 *      negative-equity note, an absence explanation, the unexplained-plug
 *      sentence the integrity gate demands. These are the last prose to go
 *      and the ones the reader least affords to lose;
 *   4. the longest surviving note, truncated. The lever of last resort, and
 *      the only one that always converges.
 *
 * AND THE PAGE SAYS WHAT IT DROPPED. A trailing disclosure states the count,
 * because silent truncation is worse than an extra sheet: an extra sheet is
 * visible and a missing sentence is not. Room for that disclosure is
 * reserved BEFORE the trimming starts, or the sentence explaining the
 * omission would be the thing that caused one.
 */
import {
  BLOCK_GAP_MM,
  blockMm,
  pageBoxMm,
  pageMm,
  pageOrientation,
  type MeasurablePage,
} from './packPageMetrics';
import type { PackDisclosureNote, PackPageBlock } from './packPageModel';

/** The paper this page has left over, in millimetres. Negative where it does
 *  not fit — see `fitPageToBox`. What page 11 spends on its matters table. */
export function remainingPageMm(page: MeasurablePage): number {
  return pageBoxMm(page) - pageMm(page);
}

/** What a page had to leave out, for the note that says so. */
interface Dropped {
  notes: number;
  footnotes: number;
  truncated: number;
}

const NOTHING: Dropped = { notes: 0, footnotes: 0, truncated: 0 };

/** The heading the omission disclosure prints under. Exported so the tests
 *  and the integrity gate name the same block rather than a second spelling. */
export const OMISSION_HEADING = 'Not printed on this page';

/** The shortest a truncated note is cut to. Below this the sentence stops
 *  saying anything and the ellipsis is the whole note. */
const MIN_NOTE_BODY = 60;

function omissionNote(dropped: Dropped): PackDisclosureNote {
  const parts: string[] = [];
  if (dropped.notes > 0) {
    parts.push(`${dropped.notes} explanatory ${dropped.notes === 1 ? 'note' : 'notes'}`);
  }
  if (dropped.footnotes > 0) {
    parts.push(`${dropped.footnotes} ${dropped.footnotes === 1 ? 'footnote' : 'footnotes'}`);
  }
  if (dropped.truncated > 0) {
    parts.push(`${dropped.truncated} shortened ${dropped.truncated === 1 ? 'note' : 'notes'}`);
  }
  return {
    heading: 'What is missing',
    body:
      `This page had room for its figures and not for all of its prose: ${parts.join(', ')} `
      + 'are not printed in full. Every figure, table and chart the page carries is complete — '
      + 'a board pack is the same twelve sheets for every company, and a sheet that cannot hold '
      + 'its own commentary says so rather than running onto a thirteenth.',
  };
}

function omissionBlock(dropped: Dropped): PackPageBlock {
  return { kind: 'disclosure', disclosure: { heading: OMISSION_HEADING, notes: [omissionNote(dropped)], required: true } };
}

/**
 * The block whose trailing note the next trim would take, or null when none
 * is left at this protection level.
 *
 * `'optional'` walks the disclosures the pack chose to make and will take
 * every note of them; `'required'` walks the ones it must make — §3.5's
 * negative-equity consequence, an absence explanation, the unexplained-plug
 * sentence — and never takes their first, because a required disclosure
 * reduced to nothing is a disclosure that was not made.
 */
function lastTrimmableNote(blocks: PackPageBlock[], level: 'optional' | 'required'): number | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]!;
    if (block.kind !== 'disclosure') continue;
    if (block.disclosure.heading === OMISSION_HEADING) continue;
    const required = block.disclosure.required === true;
    if (required !== (level === 'required')) continue;
    if (block.disclosure.notes.length > (required ? 1 : 0)) return i;
  }
  return null;
}

/** Drop the last note of block `index`, removing the block if that empties it. */
function dropNote(blocks: PackPageBlock[], index: number): void {
  const block = blocks[index]!;
  if (block.kind !== 'disclosure') return;
  const notes = block.disclosure.notes.slice(0, -1);
  if (notes.length === 0) blocks.splice(index, 1);
  else blocks[index] = { kind: 'disclosure', disclosure: { ...block.disclosure, notes } };
}

/**
 * Halve the longest surviving note's body, marked with an ellipsis so a
 * reader sees the sentence was cut.
 *
 * The lever of last resort, and the one that has to terminate: every call
 * must return a STRICTLY shorter body or the loop above never ends. Hence
 * `MIN_NOTE_BODY` and the `- 2`: halving a 61-character body to 60 plus an
 * ellipsis is 61 characters again.
 */
function truncateLongestNote(blocks: PackPageBlock[]): boolean {
  let best: { block: number; note: number; length: number } | null = null;
  for (const [i, block] of blocks.entries()) {
    if (block.kind !== 'disclosure' || block.disclosure.heading === OMISSION_HEADING) continue;
    for (const [j, note] of block.disclosure.notes.entries()) {
      if (note.body.length <= MIN_NOTE_BODY) continue;
      if (best === null || note.body.length > best.length) best = { block: i, note: j, length: note.body.length };
    }
  }
  if (best === null) return false;
  const block = blocks[best.block]!;
  if (block.kind !== 'disclosure') return false;
  const notes = block.disclosure.notes.map((note, j) => j !== best!.note ? note : {
    ...note,
    body: `${note.body.slice(0, Math.min(note.body.length - 2, Math.max(MIN_NOTE_BODY, Math.floor(note.body.length / 2)))).trimEnd()}…`,
  });
  blocks[best.block] = { kind: 'disclosure', disclosure: { ...block.disclosure, notes } };
  return true;
}

/**
 * The page, trimmed until the model says it fits its sheet.
 *
 * Returned unchanged — the same object — when it already fits, which is
 * every page of every fixture the harness carries today. The trimming path
 * is the safety net for the company nobody sampled, which is the one that
 * has produced all three overflows so far.
 */
export function fitPageToBox<T extends MeasurablePage>(page: T): T {
  const box = pageBoxMm(page);
  if (pageMm(page) <= box) return page;

  const orientation = pageOrientation(page);
  // Reserved first, at its own cost: the sentence that explains the omission
  // must not be the reason for one.
  const reserve = blockMm(omissionBlock({ notes: 9, footnotes: 9, truncated: 9 }), orientation) + BLOCK_GAP_MM;
  const budget = box - reserve;

  const blocks: PackPageBlock[] = [...page.blocks];
  const footnotes = [...page.footnotes];
  const dropped: Dropped = { ...NOTHING };
  const over = () => pageMm({ ...page, blocks, footnotes }) > budget;

  while (over()) {
    const optional = lastTrimmableNote(blocks, 'optional');
    if (optional !== null) { dropNote(blocks, optional); dropped.notes += 1; continue; }
    if (footnotes.length > 0) { footnotes.pop(); dropped.footnotes += 1; continue; }
    const required = lastTrimmableNote(blocks, 'required');
    if (required !== null) { dropNote(blocks, required); dropped.notes += 1; continue; }
    if (truncateLongestNote(blocks)) { dropped.truncated += 1; continue; }
    // Nothing left that this may take. The page keeps its figures and the
    // print harness fails the build rather than a director receiving a
    // thirteenth sheet nobody was told about.
    break;
  }

  return { ...page, blocks: [...blocks, omissionBlock(dropped)], footnotes };
}
