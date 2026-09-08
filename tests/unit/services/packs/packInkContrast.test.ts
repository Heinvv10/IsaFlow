/**
 * EVERY INK THE PACK SETS TYPE IN IS LEGIBLE ON PAPER.
 *
 * A blind gate measured the rendered pack: table body 17.4:1, footnotes
 * 3.45:1, chart axis numbers and category labels 2.54:1, page 10's panel axis
 * labels 2.16:1. The last two are ONE colour — `#9ca3af` at twelve points and
 * at eight, where the rasteriser thins the strokes further — and the footnote
 * grey is a second, `#8a8a8a`.
 *
 * It fails as a criterion rather than annoying as a preference because the
 * small type is load-bearing. Page 10 claims a rescaled panel prints its own
 * axis at both ends and quotes 37, 58, 1 908 and (1 621) — figures that
 * appear nowhere else in the pack. The sheet earns the claim and then sets
 * its only evidence at half the contrast of its own footnotes, with the zero
 * end a bare en dash.
 *
 * 4.5:1 is WCAG AA for normal text, and every ink here carries type at 12pt
 * or smaller, so none of them qualifies for the large-text exemption.
 *
 * GRIDLINES ARE NOT IN THIS. `palette.prior` is a hairline rule, not a line
 * of type; it is deliberately faint and darkening it changes what the charts
 * ARE rather than what can be read off them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { contrastRatio, relativeLuminance } from '@/lib/brand/contrast';
import { DEFAULT_CHART_PALETTE, labelInkOn } from '@/modules/accounting/services/packs/packChartOptions';

const PAPER = '#ffffff';
const MIN = 4.5;

/** The inks the pack sets TYPE in, by where a reader meets them. */
const CHART_TYPE: Array<[string, string]> = [
  ['chart axis labels and category names', DEFAULT_CHART_PALETTE.axis],
  ['a bar label outside its bar', DEFAULT_CHART_PALETTE.ink],
];

/** The print stylesheet's own tokens, read from the file rather than
 *  restated here — a copy of a colour is a copy that can drift. */
function cssToken(name: string): string {
  const css = readFileSync('styles/packPrint.css', 'utf8');
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{3,8})`, 'i').exec(css);
  expect(match, `${name} is not defined in packPrint.css`).not.toBeNull();
  return match![1]!;
}

describe('the pack sets no type in an ink a reader cannot read', () => {
  for (const [where, ink] of CHART_TYPE) {
    it(`keeps ${where} above ${MIN}:1`, () => {
      expect(contrastRatio(ink, PAPER), `${ink} for ${where}`).toBeGreaterThanOrEqual(MIN);
    });
  }

  for (const token of ['pack-ink', 'pack-grey-strong', 'pack-grey-mid']) {
    it(`keeps --${token} above ${MIN}:1`, () => {
      const ink = cssToken(token);
      expect(contrastRatio(ink, PAPER), `--${token} is ${ink}`).toBeGreaterThanOrEqual(MIN);
    });
  }

  it('still lets the axis recede behind the ink it sits under', () => {
    // The mirror case: satisfying the floor by setting every grey to black
    // would pass the tests above and flatten the page into one weight.
    expect(
      contrastRatio(DEFAULT_CHART_PALETTE.axis, PAPER),
      'the axis is as dark as the ink, so nothing on the chart recedes',
    ).toBeLessThan(contrastRatio(DEFAULT_CHART_PALETTE.ink, PAPER) / 2);
  });

  /**
   * AND THE ONE INK THAT IS NOT SET ON PAPER.
   *
   * A bridge bar that reaches the top of its plot carries its value INSIDE
   * the bar, and `labelInkOn` picks the darker or lighter of the pack's two
   * inks by contrast against the FILL. Everything above measures against the
   * paper, so this pair — the only type in the pack whose background is a
   * chart colour — was the one reading no test made. The thirty-first visual
   * gate came back on it, reporting Brightsphere p6's `(5 535)` at 4.44:1;
   * the vector gives the fill as `.1804 .6157 .3882` (#2e9d63) and the label
   * as `.0824 .1255 .1686` (#15202b), which is 4.81:1 under WCAG 2.1. The
   * finding was a miscalculation and the colours did not move — but nothing
   * was measuring it, which is what this closes.
   *
   * Mutation: raise `PRINT_FAV` back toward the app's on-screen `#1f7a4d`,
   * or lighten it past the point where paper wins, and this goes red.
   */
  const BAR_FILLS: Array<[string, string]> = [
    ['an income bar', DEFAULT_CHART_PALETTE.fav],
    ['a cost bar', DEFAULT_CHART_PALETTE.unfav],
    ['a subtotal bar', DEFAULT_CHART_PALETTE.ink],
  ];

  for (const [where, fill] of BAR_FILLS) {
    it(`keeps a label inside ${where} above ${MIN}:1`, () => {
      const ink = labelInkOn(fill, DEFAULT_CHART_PALETTE);
      expect(
        contrastRatio(ink, fill),
        `${ink} on ${fill} for ${where} — and the other ink is `
        + `${contrastRatio(ink === DEFAULT_CHART_PALETTE.paper
          ? DEFAULT_CHART_PALETTE.ink : DEFAULT_CHART_PALETTE.paper, fill).toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(MIN);
    });
  }

  it('picks the better of the two inks, not merely a passing one', () => {
    // The mirror case: a rule that returned `ink` unconditionally would pass
    // every assertion above on the fills this pack happens to use today, and
    // put near-black type on the next dark fill anyone adds.
    for (const [, fill] of BAR_FILLS) {
      const chosen = labelInkOn(fill, DEFAULT_CHART_PALETTE);
      const other = chosen === DEFAULT_CHART_PALETTE.paper
        ? DEFAULT_CHART_PALETTE.ink
        : DEFAULT_CHART_PALETTE.paper;
      expect(contrastRatio(chosen, fill), `a worse ink was chosen for ${fill}`)
        .toBeGreaterThanOrEqual(contrastRatio(other, fill));
    }
  });

  /**
   * AND THE THREE BRIDGE INKS STILL SEPARATE IN MONOCHROME, which page 12
   * claims in so many words ("all three also differ in lightness, so a
   * monochrome copy still separates them"). Darkening the green to chase a
   * label-contrast number would close that gap, so the claim is measured
   * beside the number rather than after it.
   */
  it('keeps the three bridge inks apart under a greyscale copy', () => {
    const l = (hex: string) => relativeLuminance(hex);
    const greys = [DEFAULT_CHART_PALETTE.fav, DEFAULT_CHART_PALETTE.unfav, DEFAULT_CHART_PALETTE.ink]
      .map(l)
      .sort((a, b) => a - b);
    for (let i = 1; i < greys.length; i += 1) {
      expect(greys[i]! / greys[i - 1]!, 'two bridge inks converge in greyscale')
        .toBeGreaterThanOrEqual(1.5);
    }
  });

  it('reads the colours it checks off the pack, not off a copy', () => {
    // NOT VACUOUS: if the token names ever move, the reader above returns
    // nothing and every assertion becomes true of an empty string.
    expect(cssToken('pack-grey-mid')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(DEFAULT_CHART_PALETTE.axis).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
