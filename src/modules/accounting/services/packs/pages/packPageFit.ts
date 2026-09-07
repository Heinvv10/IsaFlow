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
  pageBoxMm,
  pageMm,
  type MeasurablePage,
} from './packPageMetrics';
import type { PackFootnote, PackPageBlock } from './packPageModel';

/** The paper this page has left over, in millimetres. Negative where it does
 *  not fit — see `fitPageToBox`. What page 11 spends on its matters table. */
export function remainingPageMm(page: MeasurablePage): number {
  return pageBoxMm(page) - pageMm(page);
}

/**
 * THE TARGET IS THE SHEET. THERE IS NO SAFETY MARGIN, AND THAT IS A RESULT
 * RATHER THAN AN OVERSIGHT.
 *
 * There was one, of four millimetres, and it was covering a bug. The live
 * Brightsphere trends page measured 167.1mm in a 168mm box under the print
 * harness and took a second landscape sheet through the application's own
 * route, off the same document; four millimetres was the smallest margin that
 * made that stop, found by trying two and then four. The cause was not a
 * rounding. `PackPagesView`'s root carries `max-w-[210mm]`, so the app laid
 * every page out at portrait width — including the 261mm landscape sheet —
 * while the harness, which loads no Tailwind utilities, laid it out at 261.
 * Fifty-one millimetres of measure, showing up as ten to fourteen of height.
 *
 * With `html.print-mode .pack-pages { max-width: none }` in `packPrint.css`
 * and the harness loading the application's own reset, the two probes agree
 * to 0.1mm on every page of both companies — which is the rounding of the
 * millimetre conversion itself. There is nothing left for a margin to cover
 * that is not already covered where it belongs: `packPageMetrics` is
 * conservative by construction and `packSheetCount.test.ts` asserts that its
 * estimate never reads short of Chromium's own layout, on every page of every
 * fixture. Since the fit targets the ESTIMATE and the estimate is never below
 * the content, a page the fit passes is a page that fits.
 *
 * WHAT WOULD DEFEAT IT: content whose layout this model has not seen, laid
 * out taller than it predicts — a font update that changes IBM Plex's
 * advances, a Chromium line-breaking change, a new block kind added to
 * `blockMm` without being measured. Every one of those makes the
 * never-under-estimates assertion go red in CI, which is where it should be
 * caught, and none of them is a millimetre a blanket margin would have
 * absorbed anyway.
 */

/** What a page had to leave out, for the note that says so. */
export interface Dropped {
  notes: number;
  footnotes: number;
  truncated: number;
}

const NOTHING: Dropped = { notes: 0, footnotes: 0, truncated: 0 };

/**
 * How the page says it left something out, and WHY IT IS A FOOTNOTE.
 *
 * It began as a trailing disclosure block, and on the live Brightsphere
 * balance sheet that block WAS the overflow: 26mm of heading, gap and body
 * explaining an omission, on a page that then ran 12mm past the paper and
 * took the thirteenth sheet the trimming existed to prevent. A page short of
 * four millimetres cannot pay a centimetre to say so.
 *
 * A footnote costs a fifth of that, is set in the same 7.5pt grey the pack
 * already uses for facts ABOUT a page rather than on it, and sits where a
 * reader looks for what else there is. The pack's statement pages already
 * carry unreferenced footnotes of exactly this kind.
 *
 * Exported so the tests look for the same string the page prints rather than
 * a second spelling of it.
 */
export const OMISSION_MARK = 'This page had room for its figures and not for all of its prose';

/** The shortest a truncated note is cut to. Below this the sentence stops
 *  saying anything and the ellipsis is the whole note. */
const MIN_NOTE_BODY = 60;

function omissionText(dropped: Dropped): string {
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
  return `${OMISSION_MARK}: ${parts.join(', ')} are not printed. Every figure, `
    + 'table and chart on it is complete; a board pack is the same twelve sheets for every company.';
}

/** The omission footnote, numbered after whatever survives on the page. */
function omissionFootnote(dropped: Dropped, footnotes: PackFootnote[]): PackFootnote {
  return { number: footnotes.length + 1, text: omissionText(dropped) };
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
 * Halve the longest surviving OPTIONAL note's body, marked with an ellipsis
 * so a reader sees the sentence was cut.
 *
 * A required disclosure is never abridged. §3.5's negative-equity
 * consequence is one sentence long by design and shortening it would leave a
 * mandatory disclosure half made — worse than the millimetre of margin it
 * would buy. A page with nothing optional left to cut keeps what it has, and
 * the printed-box assertion in `packSheetCount.test.ts` is what decides
 * whether that was survivable.
 *
 * The lever of last resort, and the one that has to terminate: every call
 * must return a STRICTLY shorter body or the loop above never ends. Hence
 * `MIN_NOTE_BODY` and the `- 2`: halving a 61-character body to 60 plus an
 * ellipsis is 61 characters again.
 */
function truncateLongestNote(blocks: PackPageBlock[]): boolean {
  let best: { block: number; note: number; length: number } | null = null;
  for (const [i, block] of blocks.entries()) {
    if (block.kind !== 'disclosure' || block.disclosure.required === true) continue;
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
  return fitPageReport(page).page;
}

/** The same fit, with what it took — for the tests that hold the model to a
 *  bound on how much a page may lose to it. */
export function fitPageReport<T extends MeasurablePage>(page: T): { page: T; dropped: Dropped } {
  const box = pageBoxMm(page);
  if (pageMm(page) <= box) return { page, dropped: NOTHING };

  const blocks: PackPageBlock[] = [...page.blocks];
  const footnotes: PackFootnote[] = [...page.footnotes];
  const dropped: Dropped = { ...NOTHING };
  // THE PAGE IS MEASURED WITH THE FOOTNOTE THAT EXPLAINS THE TRIMMING ON IT.
  // A budget that reserves a flat allowance instead over-trims a page that
  // needed one note off, and under-trims the page where the allowance turns
  // out to be too small. Measuring the actual document stops as soon as the
  // actual document fits.
  const over = () => pageMm({
    ...page,
    blocks,
    // Sized at the LONGEST wording the footnote can take, not at the one the
    // drops so far would print: the sentence grows a clause per kind of thing
    // dropped, and a page measured against the short form and printed with
    // the long one is a page measured against a document it does not become.
    footnotes: [...footnotes, omissionFootnote({ notes: 9, footnotes: 9, truncated: 9 }, footnotes)],
  }) > box;

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

  // NOTHING TAKEN, NOTHING SAID — and nothing added.
  //
  // A page whose only prose is a required one-note disclosure has no lever
  // this function may pull, and the first version appended the "what is
  // missing" note anyway: 26mm of disclosure explaining an omission that had
  // not happened, on a page that then ran 12mm past the paper because of it.
  // The note was the overflow.
  if (dropped.notes === 0 && dropped.footnotes === 0 && dropped.truncated === 0) {
    return { page, dropped: NOTHING };
  }
  return {
    page: { ...page, blocks, footnotes: [...footnotes, omissionFootnote(dropped, footnotes)] },
    dropped,
  };
}
