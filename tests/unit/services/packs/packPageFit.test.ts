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

  it('returns the page untouched, and the same object, when it already fits', () => {
    const subject = page([disclosure('Reading this page', 2)]);
    expect(pageMm(subject)).toBeLessThanOrEqual(pageBoxMm(subject));
    const { page: fitted, dropped } = fitPageReport(subject);
    expect(fitted).toBe(subject);
    expect(dropped).toEqual({ notes: 0, requiredNotes: 0, footnotes: 0 });
  });
});
