/**
 * WHAT `fitPageToBox` MAY TAKE OFF A PAGE, AND WHAT IT REFUSES TO PASS.
 *
 * The sheet count lives in `tests/unit/print/packSheetCount.test.ts`, on
 * paper, where it belongs. This is the other half: the ORDER the trimmer
 * takes things in, and the two boundaries where it has to stop — a required
 * disclosure it may abridge but never silence, and a page it cannot fit at
 * all, which it must refuse rather than hand back.
 */
import { describe, expect, it } from 'vitest';
import { PackRefusal, packRefusalMessages } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { fitPageReport, OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import type { PackDisclosureNote, PackPage, PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';

const SENTENCE =
  'The prior column is the comparative period the basis page states, and a movement is never '
  + 'shown as a move from zero where that period carries no value for the measure.';

const note = (n: number): PackDisclosureNote[] =>
  Array.from({ length: n }, (unused, i) => ({ heading: `Note ${i + 1}`, body: SENTENCE }));

const disclosure = (heading: string, notes: number, required?: boolean): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: { heading, notes: note(notes), ...(required === true ? { required: true } : {}) },
});

const page = (blocks: PackPageBlock[], footnotes = 0): PackPage => ({
  number: 7,
  title: 'Total equity is a negative 4 088, and the asset side is below zero too.',
  navLabel: 'Balance sheet',
  section: 'Financials',
  orientation: 'portrait',
  density: 'high',
  blocks,
  footnotes: Array.from({ length: footnotes }, (unused, i) => ({ number: i + 1, text: SENTENCE })),
});

describe('a page the composer cannot fit', () => {
  it('takes the pack\'s own prose before the disclosures it must make', () => {
    const subject = page([
      disclosure('Negative equity', 1, true),
      disclosure('Reading this page', 30),
    ]);
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));

    const { page: fitted, dropped } = fitPageReport(subject);
    expect(pageMm(fitted)).toBeLessThanOrEqual(pageBoxMm(fitted));
    expect(dropped.notes).toBeGreaterThan(0);
    // The required disclosure is untouched while optional prose remains.
    expect(dropped.requiredNotes).toBe(0);
    const required = fitted.blocks.find(
      (b) => b.kind === 'disclosure' && b.disclosure.required === true,
    );
    expect(required?.kind === 'disclosure' && required.disclosure.notes).toHaveLength(1);
  });

  /**
   * A FOOTNOTE THAT EXPLAINS A PRINTED FIGURE IS NOT PROSE THE PAGE MAY
   * ECONOMISE ON.
   *
   * The trimmer popped footnotes last-first, and on the live Brightsphere
   * income statement the last one was the sign-flip note — the only thing on
   * the sheet reconciling the table's `(3 717)` with the `3 717` the bridge
   * below it draws. It went, and the sheet printed a chart apparently
   * contradicting the table beside it.
   */
  it('never takes a footnote that explains a figure while an ordinary one remains', () => {
    // Six footnotes, the LAST of which explains a figure, on a page whose
    // only other lever is a disclosure the pack must make — so the trimmer is
    // past optional prose and into footnotes before it stops.
    const subject = page([disclosure('Negative equity', 17, true)], 6);
    // Distinct texts, so "which footnote survived" is answerable at all.
    subject.footnotes.forEach((f, i) => { f.text = `Footnote ${i}. ${SENTENCE}`; });
    // LAST, which is where Brightsphere's sign-flip note sat and why
    // `footnotes.pop()` reached it first.
    subject.footnotes[5]!.required = true;
    const marks = subject.footnotes.map((f) => f.text);
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));

    const { page: fitted, dropped } = fitPageReport(subject);
    expect(dropped.footnotes).toBeGreaterThan(0);
    expect(
      fitted.footnotes.map((f) => f.text),
      'the trimmer took the note that explains a figure',
    ).toContain(marks[5]!);
    // And what it took instead came off the END: the ordinary footnotes that
    // survive are a prefix of the ordinary footnotes it started with, so the
    // order is still last-first past the ones it may not take.
    const ordinary = fitted.footnotes
      .filter((f) => f.required !== true && !f.text.startsWith(OMISSION_MARK))
      .map((f) => f.text);
    const started = marks.filter((m) => m !== marks[5]);
    expect(ordinary).toEqual(started.slice(0, ordinary.length));
  });

  it('abridges a required disclosure rather than take the last figure footnote', () => {
    const subject = page([disclosure('Negative equity', 40, true)], 1);
    subject.footnotes[0]!.required = true;
    const mark = subject.footnotes[0]!.text;

    const { page: fitted, dropped } = fitPageReport(subject);
    expect(fitted.footnotes.map((f) => f.text)).toContain(mark);
    expect(dropped.footnotes).toBe(0);
    expect(dropped.requiredNotes).toBeGreaterThan(0);
    expect(pageMm(fitted)).toBeLessThanOrEqual(pageBoxMm(fitted));
  });

  it('says on the page when it had to abridge a disclosure the pack must make', () => {
    // Nothing optional to take, so the only lever left is the tail of a
    // required block — which it may pull, and must then own.
    const subject = page([disclosure('Negative equity', 40, true)]);
    const { page: fitted, dropped } = fitPageReport(subject);

    expect(dropped.requiredNotes).toBeGreaterThan(0);
    const said = fitted.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
    expect(said, 'the page dropped a statutory note and said nothing').toBeDefined();
    expect(
      said!.text,
      'the page says notes are missing without saying one of them was required',
    ).toContain('required to make');
    // It takes only what the page needed — not the whole block — and never
    // the last note, which would leave a heading over a disclosure that was
    // not made.
    const required = fitted.blocks[0];
    const left = required?.kind === 'disclosure' ? required.disclosure.notes.length : 0;
    expect(left).toBeGreaterThanOrEqual(1);
    expect(left).toBeLessThan(40);
    expect(pageMm(fitted)).toBeLessThanOrEqual(pageBoxMm(fitted));
  });

  /**
   * AND THE NOTICE IS WRITTEN FOR THE READER, NOT ABOUT THE COMPOSITOR.
   *
   * It reached paper as: `This page had room for its figures and not for all
   * of its prose: 1 explanatory note — from "Commentary" is not printed.` A
   * board pack does not narrate its own production, the em-dashed clause sat
   * between the subject and its verb so the sentence did not parse, and the
   * heading was set in straight double quotes in a document that uses
   * typographic ones everywhere else.
   */
  it('names what is missing in the reader\'s terms, not the compositor\'s', () => {
    const subject = page([disclosure('Commentary', 40, false)]);
    const said = fitPageReport(subject).page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
    expect(said, 'the page dropped a note and said nothing').toBeDefined();
    const text = said!.text;

    // What is missing, named.
    expect(text).toContain('explanatory note');
    expect(text, 'the reader is not told which disclosure lost its note').toContain('Commentary');
    // And that no FIGURE was touched, which is the part that decides whether
    // the omission matters.
    expect(text).toContain('Every figure, table and chart on the page is complete');

    // Not the pack talking about its own layout.
    for (const production of ['had room', 'not for all of its prose', 'this page had']) {
      expect(text.toLowerCase(), `the notice describes the compositor's problem: "${production}"`)
        .not.toContain(production);
    }
    // Typographic quotes, like the rest of the pack.
    expect(text, 'straight double quotes reached a printed sheet').not.toContain('"');
    // And it parses: no clause cut in half by a dash before its verb.
    expect(text, 'an em-dashed clause splits the subject from its verb').not.toMatch(/—[^.]*\bis not printed/);
  });

  it('REFUSES a page it cannot fit rather than handing it back over the paper', () => {
    // One required note longer than the sheet. There is no lever: its first
    // note is never taken, and there is nothing else on the page. The first
    // version returned this unchanged — 618mm in a 255mm box, reporting
    // nothing dropped, with no footnote and no error — which is a thirteenth
    // sheet under a contents page that indexes twelve.
    //
    // Not reachable from today's `mustDisclose` callers, every one of which
    // passes a single sentence. That is the argument for refusing it: the
    // next caller is the one that writes a long one.
    const huge: PackPageBlock = {
      kind: 'disclosure',
      disclosure: {
        heading: 'Negative equity',
        notes: [{ heading: 'Consequence', body: SENTENCE.repeat(40) }],
        required: true,
      },
    };
    const subject = page([huge]);
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));
    expect(() => fitPageReport(subject)).toThrow(/Balance sheet/);
    expect(() => fitPageReport(subject)).toThrow(/nothing left on it that may be dropped/);
  });

  /**
   * WHAT THE USER SEES IS NOT WHAT THE LOG SEES.
   *
   * Brightsphere's 422 reached the screen beginning "fitPageToBox:" and
   * quoting 264.9mm against 255mm. The millimetres diagnose it; they are not
   * something a person reading a failed download can act on, and the function
   * name is nobody's business but ours.
   */
  it('refuses in two registers: millimetres for the log, a sentence for the reader', () => {
    const huge: PackPageBlock = {
      kind: 'disclosure',
      disclosure: {
        heading: 'Negative equity',
        notes: [{ heading: 'Consequence', body: SENTENCE.repeat(40) }],
        required: true,
      },
    };

    let thrown: unknown;
    try { fitPageReport(page([huge])); } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(PackRefusal);
    const { user, diagnostic } = packRefusalMessages(thrown);
    expect(diagnostic).toMatch(/fitPageToBox/);
    expect(diagnostic).toMatch(/mm/);
    expect(user).not.toMatch(/fitPageToBox/);
    expect(user).not.toMatch(/\d+(\.\d+)?mm/);
    // It still names the page, because that is the one thing the reader can
    // repeat back to whoever they ask.
    expect(user).toMatch(/Balance sheet/);
  });

  it('returns the page untouched, and the same object, when it already fits', () => {
    const subject = page([disclosure('Reading this page', 2)]);
    expect(pageMm(subject)).toBeLessThanOrEqual(pageBoxMm(subject));
    const { page: fitted, dropped } = fitPageReport(subject);
    expect(fitted).toBe(subject);
    expect(dropped).toEqual({ notes: 0, requiredNotes: 0, footnotes: 0, from: [] });
  });
});

/**
 * AND THE COMPOSER REALLY CALLS IT, ON A DOCUMENT BUILT FROM AN INPUT.
 *
 * Everything above holds `fitPageReport` on a page assembled by hand. That
 * left a gap a mutation found: `fitPageToBox` — the wrapper
 * `buildBoardPackPages` actually calls on all eleven body pages and on the
 * basis page — can be made the identity function with this file green, with
 * nine of the eleven `packSheetCount` fixtures green, and with the whole unit
 * suite green apart from the two probes in that file that build an
 * overflowing page themselves. The per-fixture sheet counts show the fixtures
 * FIT; they do not show the trimming works, because none of them reaches it.
 *
 * THIS ONE REACHES IT, FROM AN INPUT. The lever is an approved board
 * commentary of ten paragraphs on the live Brightsphere pack — the pack's
 * fixtures all carry `commentary: null`, because nothing in this codebase
 * stores board commentary yet, and a chair who writes a page of it is the
 * ordinary case the day one does. Page 4 then measures 286.3mm against a
 * 255mm sheet and the composer has to trim it.
 */
describe('the composer trims a page its input overflowed', () => {
  const PARAGRAPH =
    'Trading in the second half held up against a first half that carried the year, and the board '
    + 'should read the margin recovery as a mix effect rather than a pricing gain: the two largest '
    + 'contracts renewed at the same rates and the improvement is in what it cost to serve them. ';

  const withCommentary = (paragraphs: number): BoardPackInput => ({
    ...brightsphereLiveInput,
    commentary: { status: 'approved', body: PARAGRAPH.repeat(paragraphs), actions: [] },
  });

  const commentaryPage = (paragraphs: number) => buildBoardPackPages(withCommentary(paragraphs))
    .pages.find((p) => p.navLabel === 'Commentary and actions')!;

  const headings = (page: ReturnType<typeof commentaryPage>): string[] => page.blocks
    .flatMap((b) => (b.kind === 'disclosure' ? [b.disclosure.heading] : []));

  it('leaves a page its input did not overflow exactly as it composed it', () => {
    // THE CONTROL. Without this the assertions below are satisfied by a
    // composer that trims every page — and the sheet either way is twelve.
    const short = commentaryPage(1);
    expect(headings(short)).toEqual(['How this page is prepared', 'How current these figures are']);
    expect(short.footnotes.filter((f) => f.text.startsWith(OMISSION_MARK))).toEqual([]);
    expect(pageMm(short)).toBeLessThanOrEqual(pageBoxMm(short));
  });

  it('drops the optional prose first, keeps the disclosure it must make, and says so', () => {
    const long = commentaryPage(10);

    // IT FITS. Under an identity fitter this page measures 286.3mm in a 255mm
    // box and takes a thirteenth sheet under a contents page that says twelve.
    expect(pageMm(long), 'the composed page is still past its sheet').toBeLessThanOrEqual(pageBoxMm(long));

    // AND IN THE RIGHT ORDER. The pack's own commentary about the page went —
    // both notes, so the block with it — and the ledger-currency disclosure,
    // which is required, is untouched. A trimmer that took them the other way
    // round would also produce a page that fits.
    expect(headings(long)).toEqual(['How current these figures are']);
    const required = long.blocks.find(
      (b) => b.kind === 'disclosure' && b.disclosure.required === true,
    );
    expect(required?.kind === 'disclosure' ? required.disclosure.notes.length : 0)
      .toBe(1);

    // AND THE PAGE SAYS WHAT IT LOST, naming the disclosure it came off.
    const said = long.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
    expect(said, 'the page dropped prose and printed nothing to say so').toBeDefined();
    expect(said!.text).toContain('2 explanatory notes');
    expect(said!.text).toContain('\u201cHow this page is prepared\u201d');
    // Nothing came out of a disclosure the pack is required to make.
    expect(said!.text).not.toContain('required to make');
    // The figures are all still there — which is the promise the sentence makes.
    expect(long.blocks.some((b) => b.kind === 'narrative')).toBe(true);
  });
});
