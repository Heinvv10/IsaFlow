/**
 * What a fitted page had to leave out, and the footnote that says so. Split
 * out of `packPageFit.ts` for the 300-line cap; that file does the trimming
 * and re-exports `Dropped` and `OMISSION_MARK`, so every caller still
 * imports them there.
 */
import { log } from '@/lib/logger';
import type { PackFootnote } from './packPageModel';

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
  /** Derived captions taken off a page that had nothing else left to give -- see `PackPageBlock.droppable`. */
  captions: number;
  /** Figures the page was composed without (`PackPage.columnsLeftOut`), named in the note. */
  columns: string[];
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

export const NOTHING: Dropped = { notes: 0, requiredNotes: 0, footnotes: 0, captions: 0, columns: [], from: [] };

/** Did this page give anything up? */
export function tookSomething(dropped: Dropped): boolean {
  return dropped.notes > 0 || dropped.requiredNotes > 0 || dropped.footnotes > 0 || dropped.captions > 0;
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

/**
 * Printed on page 6 when the Budget and Variance columns are left out: the pack says what it left off rather than only
 * logging it. It lives here, not with page 6's composer, because the omission note reads the page's footnotes for it.
 */
export const BUDGET_COLUMNS_DROPPED_NOTE =
  'The Budget and Variance columns are left out of this page because the figures are too wide to fit it.';

function omissionText(dropped: Dropped, footnotes: readonly PackFootnote[]): string {
  // The disclosure headings name where NOTES were taken from, so the clause is attached to the note
  // parts and the parts with no heading (footnotes, captions) follow it, set apart by semicolons:
  // "2 explanatory notes, from “Commentary”; 3 footnotes; 1 derived caption".
  const noteParts: string[] = [];
  if (dropped.notes > 0) {
    noteParts.push(`${dropped.notes} explanatory ${dropped.notes === 1 ? 'note' : 'notes'}`);
  }
  if (dropped.requiredNotes > 0) {
    noteParts.push(`${dropped.requiredNotes} ${dropped.requiredNotes === 1 ? 'note' : 'notes'} from a `
      + 'disclosure this pack is required to make');
  }
  const where = dropped.from.length === 0
    ? ''
    : `, from ${dropped.from.map((h) => `\u201c${h}\u201d`).join(' and ')}`;
  const parts: string[] = [];
  if (noteParts.length > 0) parts.push(`${noteParts.join(', ')}${where}`);
  if (dropped.footnotes > 0) parts.push(`${dropped.footnotes} ${dropped.footnotes === 1 ? 'footnote' : 'footnotes'}`);
  if (dropped.captions > 0) parts.push(`${dropped.captions} derived ${dropped.captions === 1 ? 'caption' : 'captions'}`);
  // THE COLUMNS A PAGE WAS COMPOSED WITHOUT ARE FIGURES, so the note that names them cannot go on to say
  // every figure is printed: "every OTHER figure" is what is true.
  // Said ONCE, and DERIVED from the page rather than flagged: where a footnote of the page already says they are
  // not printed (whichever path put it there), this one does not repeat it.
  const said = footnotes.some((f) => f.text === BUDGET_COLUMNS_DROPPED_NOTE);
  if (dropped.columns.length > 0 && !said) parts.push(`the ${dropped.columns.join(' and ')} columns`);
  return `${OMISSION_MARK}: ${parts.join('; ')}. `
    + `Every ${dropped.columns.length > 0 ? 'other ' : ''}figure, table and chart on the page is complete`
    + ` — what ${dropped.columns.length > 0 ? 'else ' : ''}is missing is prose about them, and it can be asked for.`;
}

/**
 * The omission footnote, numbered past every number still on the page.
 *
 * PAST THE HIGHEST, not after the count. A surviving footnote keeps the
 * number the table's own superscript points at, so the trimmer leaves GAPS —
 * take note 2 of three and 1 and 3 remain. Numbering off the length then
 * issued a second 3, and the page printed two footnotes under one marker.
 */
export function omissionFootnote(dropped: Dropped, footnotes: PackFootnote[]): PackFootnote {
  return { number: Math.max(0, ...footnotes.map((f) => f.number)) + 1, text: omissionText(dropped, footnotes) };
}

/**
 * Said in the log, once, for the page that is actually used: a derived caption was taken to make the
 * page fit. The fit also runs as a probe whose page is thrown away, so the callers that use a fitted
 * page call this and the fit itself stays silent.
 */
export function warnCaptionDropped(navLabel: string, dropped: Dropped): void {
  if (dropped.captions === 0) return;
  log.warn(`board pack: "${navLabel}" cannot fit its sheet with its derived caption; the caption is not printed`,
    { navLabel, captions: dropped.captions }, 'packs');
}
