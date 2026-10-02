/**
 * THE PACK'S TWO MOST PROMINENT NUMBERS COULD NOT BE CHECKED ON THEIR OWN
 * SHEETS, AND THE PACK GAVE NO REASON.
 *
 * The demo pack headlines a gross margin of (1310.8%) on page 3 and page 6.
 * A director divides the two figures printed beside it — (1 329) over 101 —
 * and gets (1315.8%). Five percentage points. The figures are right: revenue
 * is R101 424 and the margin is taken on that, not on the 101 the sheet
 * prints. What was missing was the disclosure, and the Rounding note covered
 * only the other half of rounding — a column that does not foot.
 *
 * These hold both halves of the sentence that closes it. The FIRST is that
 * the condition is real on this pack, so the disclosure is load-bearing
 * rather than boilerplate: a printed percentage that does not reproduce from
 * the rounded amounts beside it must actually exist, or the sentence is
 * describing nothing. The SECOND is that the sentence is on the page a
 * director turns to, in the same words the statement footnotes carry — one
 * convention, one string, because two wordings of one rule is one edit away
 * from a basis page and a footnote disagreeing about how this pack rounds.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  ROUNDING_COMPONENTS_NOTE,
  ROUNDING_NOTE,
  ROUNDING_RATIOS_NOTE,
  PACK_SCALE,
} from '@/modules/accounting/services/packs/pages/packBasis';
import { MONEY_SCALES } from '@/lib/format/money';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import { brightsphereInput, demoInput } from './fixtures/boardPackInputs';

/** A figure as the sheet prints it, in the pack's scale. */
const printed = (n: number): number =>
  Math.sign(n) * Math.round(Math.abs(n) / MONEY_SCALES[PACK_SCALE]);

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['demo', demoInput],
  ['brightsphere', brightsphereInput],
];

/** Every quotient figure in the composed document that states its working —
 *  the numerator and denominator the integrity gate recomputes it from. */
function quotients(input: BoardPackInput): Array<{ source: string; value: number; n: number; d: number }> {
  const out: Array<{ source: string; value: number; n: number; d: number }> = [];
  for (const figure of [...buildBoardPackPages(input).provenance.all().values()].flat()) {
    if (figure.value === null || figure.basis === undefined) continue;
    if (figure.format !== 'pct') continue;
    out.push({
      source: figure.source,
      value: figure.value,
      n: figure.basis.numerator,
      d: figure.basis.denominator,
    });
  }
  return out;
}

describe('the rounding disclosure', () => {
  it('is needed: a printed percentage does not reproduce from the printed amounts', () => {
    const drifting = quotients(liveDemoRenderedInput).filter(({ value, n, d }) => {
      const base = printed(d);
      if (base === 0) return false;
      const fromPrinted = (printed(n) / base) * 100;
      // A tenth of a point is the precision the pack prints percentages at,
      // so anything at or beyond it is a discrepancy a reader can see.
      return Math.abs(fromPrinted - value) >= 0.1;
    });
    expect(
      drifting.map((q) => q.source),
      'no printed percentage drifts from the printed amounts, so this pack needs no such note',
    ).not.toEqual([]);
  });

  it('says so, on the basis page, in the pack\'s one wording', () => {
    for (const [name, input] of FIXTURES) {
      const notes = buildBoardPackPages(input).pages
        .flatMap((page) => page.blocks)
        .flatMap((block) => (block.kind === 'disclosure' ? block.disclosure.notes : []));
      const rounding = notes.filter((note) => note.heading === 'Rounding');
      expect(rounding.map((n) => n.body), `${name}: no Rounding fact on the basis page`)
        .toEqual([ROUNDING_NOTE]);
      expect(rounding[0]!.body, `${name}: the Rounding fact says nothing about a ratio`)
        .toContain(ROUNDING_RATIOS_NOTE);
    }
  });

  it('is one claim, and the statement footnote carries half of it', () => {
    // The ratio clause belongs under the `% of revenue` column too, and does
    // not fit there — see `ROUNDING_FOOTNOTES`. What must hold is that the
    // two are the SAME claim rather than two wordings of one convention:
    // the footnote says less, never something different.
    //
    // IT USED TO BE `ROUNDING_NOTE.startsWith(ROUNDING_COMPONENTS_NOTE)`, AND
    // THAT WAS A STRONGER RULE THAN THE PACK NEEDS. The footnote prints ALONE
    // on a statement sheet, so it has to name the scale to stand up; the
    // basis fact prints two rows under `Standard and currency`, which states
    // the scale already, and that restatement was the fourth line of an 83mm
    // column — the line page 12's `Reporting entity` fact is set in. The
    // claim itself is written once in `packBasis.ts` and both notes are built
    // from it, so this asserts the shared clause instead of a shared prefix.
    // Mutation: reword either note's components half by hand and this fails.
    const clause = 'components may not add exactly to the totals shown';
    expect(ROUNDING_COMPONENTS_NOTE, 'the footnote no longer makes the components claim')
      .toContain(clause);
    expect(ROUNDING_NOTE.toLowerCase(), 'the basis fact no longer makes the components claim')
      .toContain(clause);
    // And the footnote is still the half that can stand alone: it names the
    // scale, and the basis fact does not have to.
    expect(ROUNDING_COMPONENTS_NOTE).toContain(PACK_SCALE);
    expect(ROUNDING_NOTE).toContain(ROUNDING_RATIOS_NOTE);
    for (const [name, input] of FIXTURES) {
      const footnotes = buildBoardPackPages(input).pages
        .flatMap((page) => page.footnotes ?? [])
        .map((f) => f.text);
      const rounding = footnotes.filter((text) => text.includes(ROUNDING_COMPONENTS_NOTE));
      expect(rounding.length, `${name}: no statement page carries the rounding footnote`)
        .toBeGreaterThan(0);
      for (const text of rounding) expect(text, name).toBe(ROUNDING_COMPONENTS_NOTE);
    }
  });

  /**
   * AND THE SECOND CLAUSE IS TRUE TOO, WHICH IS WHY IT IS IN THE SENTENCE.
   * Page 10's scale shares and page 5's biggest-month share are computed on
   * the PRINTED figures on purpose (`atScale`), because those two sheets
   * invite the reader to do the division off the paper. A blanket "computed
   * before rounding" would be false exactly where the pack has gone to the
   * most trouble to be checkable. That half is held where those figures are
   * made — `packTrendScaleDisclosure.test.ts`'s `roundingSplit` fixture,
   * whose unrounded and printed shares differ at one decimal, and
   * `packMonthlyResults.test.ts` — rather than restated here against a
   * provenance map neither of them writes to: they are PROSE, not table
   * cells, so there is no figure to read back.
   */
});
