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
import { PackRefusal } from '../packRefusal';
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
 * estimate never reads short of Chromium's own layout, on every CONTENT page
 * of every fixture. Content pages, not all twelve: the cover and the contents
 * are laid out by `PackCoverV2` and `PackContents` rather than from a block
 * list, and neither passes through this function — so nothing unmeasured is
 * being certified, and the two are excluded rather than unnoticed. Since the
 * fit targets the ESTIMATE and the estimate is never below the content, a
 * page the fit passes is a page that fits.
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
  /** Notes off a disclosure the pack chose to make. */
  notes: number;
  /**
   * Notes off a disclosure the pack is REQUIRED to make — §3.5's
   * negative-equity consequence, an absence explanation.
   *
   * Counted apart from `notes` because the page has to say so. A footnote
   * reading "2 explanatory notes are not printed" is true of both and tells a
   * director nothing about which: one is the pack economising on its own
   * commentary, the other is a statutory disclosure printed in part. The
   * first note of a required block is never taken, so this can only ever mean
   * a disclosure was abridged, never that one was made and then removed.
   */
  requiredNotes: number;
  footnotes: number;
  /**
   * The headings of the disclosures notes were taken from, in the order they
   * were taken, without repeats.
   *
   * The footnote read "2 explanatory notes are not printed. Every figure,
   * table and chart on it is complete" — an admission of incompleteness and a
   * claim of completeness in one sentence, with nothing to say WHICH two
   * measures lost their explanation. A director cannot look up a note that is
   * not there; naming the disclosure at least says where to ask.
   */
  from: string[];
}

const NOTHING: Dropped = { notes: 0, requiredNotes: 0, footnotes: 0, from: [] };

/** Did this page give anything up? */
function tookSomething(dropped: Dropped): boolean {
  return dropped.notes > 0 || dropped.requiredNotes > 0 || dropped.footnotes > 0;
}

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
/**
 * AND IT IS WRITTEN FOR THE READER, NOT ABOUT THE COMPOSITOR.
 *
 * It read: `This page had room for its figures and not for all of its prose:
 * 1 explanatory note — from "Commentary" is not printed. Every figure, table
 * and chart on the page is complete.` Three things wrong with that sentence
 * and only one of them is grammar. It narrates the pack's own production,
 * which no listed-company pack does; it puts an em-dashed clause between the
 * subject and its verb so the sentence does not parse; and it sets the
 * disclosure heading in straight double quotes in a document that uses
 * typographic ones everywhere else.
 *
 * What a director needs from this footnote is what is not on the page and
 * whether it matters — which is: a named note, and the fact that no FIGURE
 * was touched. That is what it now says, in that order, with the production
 * detail left where it belongs, which is out.
 */
export const OMISSION_MARK = 'Not printed on this page';

function omissionText(dropped: Dropped): string {
  const parts: string[] = [];
  if (dropped.notes > 0) {
    parts.push(`${dropped.notes} explanatory ${dropped.notes === 1 ? 'note' : 'notes'}`);
  }
  if (dropped.footnotes > 0) {
    parts.push(`${dropped.footnotes} ${dropped.footnotes === 1 ? 'footnote' : 'footnotes'}`);
  }
  if (dropped.requiredNotes > 0) {
    parts.push(`${dropped.requiredNotes} ${dropped.requiredNotes === 1 ? 'note' : 'notes'} from a `
      + 'disclosure this pack is required to make');
  }
  const where = dropped.from.length === 0
    ? ''
    : `, from ${dropped.from.map((h) => `\u201c${h}\u201d`).join(' and ')}`;
  return `${OMISSION_MARK}: ${parts.join(', ')}${where}. `
    + 'Every figure, table and chart on the page is complete — what is missing is prose '
    + 'about them, and it can be asked for.';
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

/** The last index matching `keep`, or null. */
function lastIndex<T>(items: T[], keep: (item: T) => boolean): number | null {
  for (let i = items.length - 1; i >= 0; i -= 1) if (keep(items[i]!)) return i;
  return null;
}

/** Drop the last note of block `index`, removing the block if that empties it. */
function dropNote(blocks: PackPageBlock[], index: number, dropped: Dropped): void {
  const block = blocks[index]!;
  if (block.kind !== 'disclosure') return;
  if (!dropped.from.includes(block.disclosure.heading)) dropped.from.push(block.disclosure.heading);
  const notes = block.disclosure.notes.slice(0, -1);
  if (notes.length === 0) blocks.splice(index, 1);
  else blocks[index] = { kind: 'disclosure', disclosure: { ...block.disclosure, notes } };
}

/**
 * The page, trimmed until the model says it fits its sheet.
 *
 * Returned unchanged — the same object — when it already fits, which is
 * every content page of every fixture the harness carries today. The trimming path
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
  const dropped: Dropped = { ...NOTHING, from: [] };
  // THE PAGE IS MEASURED WITH THE FOOTNOTE THAT EXPLAINS THE TRIMMING ON IT.
  // A budget that reserves a flat allowance instead over-trims a page that
  // needed one note off, and under-trims the page where the allowance turns
  // out to be too small. Measuring the actual document stops as soon as the
  // actual document fits.
  const over = () => pageMm({
    ...page,
    blocks,
    // Sized against the footnote the page would ACTUALLY print, drop by drop.
    // A flat worst-case allowance was a line longer than the sentence most
    // pages get, and on the tightest page in the pack that line cost a note
    // nobody needed to lose. The sentence gains a clause per KIND of thing
    // dropped, so a drop can lengthen it — and when it does, this measures
    // over again on the next turn of the loop and takes one more. What makes
    // that safe rather than clever is `assertFits` below, which re-checks the
    // finished page against the footnote it really carries.
    footnotes: [...footnotes, omissionFootnote(dropped, footnotes)],
  }) > box;

  while (over()) {
    const optional = lastTrimmableNote(blocks, 'optional');
    if (optional !== null) { dropNote(blocks, optional, dropped); dropped.notes += 1; continue; }
    // LAST-FIRST, PAST THE ONES THAT EXPLAIN A FIGURE. `footnotes.pop()` took
    // whatever was last, and on Brightsphere's income statement that was the
    // note reconciling the table's (3 717) with the bridge's 3 717 — see
    // `PackFootnote.required`.
    const trimmable = lastIndex(footnotes, (f) => f.required !== true);
    if (trimmable !== null) { footnotes.splice(trimmable, 1); dropped.footnotes += 1; continue; }
    const required = lastTrimmableNote(blocks, 'required');
    if (required !== null) { dropNote(blocks, required, dropped); dropped.requiredNotes += 1; continue; }
    break;
  }

  // NOTHING TAKEN, NOTHING SAID — and nothing added.
  //
  // A page whose only prose is one required note has no lever this function
  // may pull, and the first version appended the "what is missing" note
  // anyway: 26mm of disclosure explaining an omission that had not happened,
  // on a page that then ran 12mm past the paper because of it. The note was
  // the overflow. This branch is also the FITS case above having been reached
  // by a page that needed nothing, which is every content page of all seven
  // fixtures — the trimming below runs on live data and on this file's own
  // tests, never on a fixture.
  if (!tookSomething(dropped)) {
    assertFits(page, page);
    return { page, dropped: NOTHING };
  }

  const fitted = { ...page, blocks, footnotes: [...footnotes, omissionFootnote(dropped, footnotes)] };
  assertFits(page, fitted);
  return { page: fitted, dropped };
}

/**
 * A PAGE THAT STILL DOES NOT FIT IS REFUSED, NOT RETURNED.
 *
 * The loop above stops when it runs out of prose it is allowed to take, and
 * the first version simply handed the page back at that point: a page whose
 * only block is one required note taller than the sheet came out at 618mm in
 * a 255mm box, reporting nothing dropped, with no footnote and no error. It
 * is not reachable from today's `mustDisclose` callers — every one of them
 * passes a single sentence — which is exactly the argument for refusing it
 * rather than trusting it. The next caller is the one that writes a long one,
 * and a silent pass here is a thirteenth sheet with a contents page that says
 * twelve.
 *
 * A THROW, like `assertPackIntegrity`'s. The pack already refuses to become a
 * document when its figures do not reconcile, and the PDF route diagnoses a
 * failed render by re-composing in-process and reporting what it refused on —
 * so this reaches a human as a sentence naming the page, rather than as a
 * corrupt download or a thirty-second timeout.
 */
function assertFits(original: MeasurablePage, fitted: MeasurablePage): void {
  const box = pageBoxMm(fitted);
  const mm = pageMm(fitted);
  if (mm <= box) return;
  // TWO SENTENCES FOR TWO READERS — see `PackRefusal`. The millimetres and the
  // function name are what diagnoses this; they are not what a person reading
  // a failed download needs, and they used to be all they got.
  throw new PackRefusal(
    `fitPageToBox: "${original.navLabel}" needs ${mm.toFixed(1)}mm and its sheet gives `
      + `${box}mm, with nothing left on it that may be dropped — every remaining note is one `
      + 'this pack is required to make. Refusing to compose a page that would print on two '
      + 'sheets under a contents page that indexes one.',
    `The "${original.navLabel}" page of this pack needs more room than one sheet gives it, and `
      + 'every note left on it is one the pack is required to make. The pack has not been '
      + 'produced, rather than printing that page across two sheets under a contents page that '
      + 'indexes one. Your figures are not the problem and nothing has been left out of them — '
      + 'please contact support with the period you asked for.',
  );
}
