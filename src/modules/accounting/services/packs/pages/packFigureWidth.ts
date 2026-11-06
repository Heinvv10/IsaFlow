/**
 * THE WIDTH OF A PRINTED FIGURE, IN DEVICE PIXELS, AS CHROMIUM LAYS IT OUT.
 *
 * Measured, not estimated. The pack's figures are set in IBM Plex Sans at three weights, and Chromium lays them
 * out as follows:
 *  - the font is snapped to a whole pixel size and every glyph's advance is rounded to a whole pixel, a half
 *    rounding down: `advance(ch) = round(em(ch) x round(fontPx))`. A digit is 0.6em (the face is tabular), so a
 *    figure's width is exact and NON-LINEAR in the size: the same figure is 4.9em wide at 8px and 5.2em at 11, so
 *    a width in ems times a size is wrong by up to 12% either way. The weights differ in a few glyphs only
 *    (`.` `%` `n` `m` and the letters).
 *
 * `tests/unit/print/packFigureWidth.test.ts` re-measures every character at every whole size from 6 to 40px in
 * Chromium under all three and fails if this table drifts, and `packNothingPassesTheEdge.test.ts` compares every
 * printed figure with `textPx`. Where a character's width is not a whole-pixel rule (a few capitals and `x y` at
 * 400/500, kerned against the `|` the measurement is taken between) its em is the largest measured plus a margin:
 * an upper bound. A character not in the table is charged 0.7em, an upper bound.
 */
// [weight 400, weight 500, weight 600]
const EM: Readonly<Record<string, readonly [number, number, number]>> = {
  '0': [0.5999, 0.5999, 0.5999],
  '1': [0.5999, 0.5999, 0.5999],
  '2': [0.5999, 0.5999, 0.5999],
  '3': [0.5999, 0.5999, 0.5999],
  '4': [0.5999, 0.5999, 0.5999],
  '5': [0.5999, 0.5999, 0.5999],
  '6': [0.5999, 0.5999, 0.5999],
  '7': [0.5999, 0.5999, 0.5999],
  '8': [0.5999, 0.5999, 0.5999],
  '9': [0.5999, 0.5999, 0.5999],
  '\u0020': [0.2365, 0.2365, 0.2365],
  '(': [0.3333, 0.3333, 0.3333],
  ')': [0.3333, 0.3333, 0.3333],
  '+': [0.5999, 0.5999, 0.5999],
  '-': [0.4001, 0.4001, 0.4001],
  '.': [0.2728, 0.2905, 0.2984],
  '/': [0.3854, 0.4197, 0.4405],
  '%': [0.9275, 0.9474, 0.96],
  '<': [0.5999, 0.5999, 0.5999],
  ',': [0.2728, 0.2905, 0.2984],
  ':': [0.2924, 0.3102, 0.3188],
  'x': [0.5063, 0.5294, 0.5455],
  '\xa0': [0.2365, 0.2365, 0.2365],
  '\u2013': [0.5884, 0.5884, 0.5884],
  '\u2212': [0.5999, 0.5999, 0.5999],
  '\xd7': [0.5999, 0.5999, 0.5999],
  'a': [0.5333, 0.5489, 0.5597],
  'b': [0.5805, 0.5929, 0.5999],
  'c': [0.5063, 0.5063, 0.5135],
  'd': [0.5805, 0.5929, 0.5999],
  'e': [0.5489, 0.5556, 0.5582],
  'f': [0.3243, 0.3405, 0.3509],
  'g': [0.5282, 0.5373, 0.5455],
  'h': [0.5685, 0.5805, 0.5884],
  'i': [0.2534, 0.2652, 0.2757],
  'j': [0.2534, 0.2652, 0.2757],
  'k': [0.53, 0.5499, 0.5655],
  'l': [0.2728, 0.2856, 0.294],
  'm': [0.8733, 0.8824, 0.8891],
  'n': [0.5685, 0.5805, 0.5884],
  'o': [0.5597, 0.5635, 0.5635],
  'p': [0.5805, 0.5929, 0.5999],
  'q': [0.5805, 0.5929, 0.5999],
  'r': [0.3671, 0.3829, 0.3938],
  's': [0.4898, 0.4905, 0.503],
  't': [0.3509, 0.3651, 0.3734],
  'u': [0.5685, 0.5805, 0.5884],
  'v': [0.4938, 0.5063, 0.5239],
  'w': [0.7691, 0.7999, 0.818],
  'y': [0.503, 0.5169, 0.5257],
  'z': [0.4649, 0.4872, 0.5063],
  'A': [0.6418, 0.6623, 0.6722],
  'B': [0.6533, 0.6596, 0.6668],
  'C': [0.6242, 0.6363, 0.6459],
  'D': [0.6713, 0.6826, 0.6898],
  'E': [0.5863, 0.5951, 0.6002],
  'F': [0.5597, 0.5715, 0.5776],
  'G': [0.6955, 0.706, 0.7124],
  'H': [0.7076, 0.7144, 0.7197],
  'I': [0.4004, 0.4197, 0.4261],
  'J': [0.5063, 0.5317, 0.5455],
  'K': [0.634, 0.6604, 0.6775],
  'L': [0.5063, 0.5135, 0.5218],
  'M': [0.8155, 0.8155, 0.8188],
  'N': [0.7076, 0.7144, 0.7197],
  'O': [0.7113, 0.7151, 0.7151],
  'P': [0.6062, 0.6266, 0.6418],
  'Q': [0.7113, 0.7151, 0.7151],
  'R': [0.6398, 0.6551, 0.6668],
  'S': [0.5822, 0.5999, 0.6119],
  'T': [0.5715, 0.5776, 0.5805],
  'U': [0.6775, 0.6864, 0.6898],
  'V': [0.6087, 0.6266, 0.6384],
  'W': [0.8921, 0.9258, 0.9491],
  'X': [0.6131, 0.6398, 0.6551],
  'Y': [0.5929, 0.6172, 0.6314],
  'Z': [0.5805, 0.5916, 0.5999],
};
const UNKNOWN_EM = 0.7;

/** Weights the pack sets figures in: a line row, a subtotal row (and every KPI figure), a total row. */
export type FigureWeight = 400 | 500 | 600;
const WEIGHT_INDEX: Readonly<Record<FigureWeight, number>> = { 400: 0, 500: 1, 600: 2 };

/** The pixel size Chromium actually sets a font at. */
export function effectivePx(fontPx: number): number {
  return Math.max(1, Math.round(fontPx));
}

/** One character's advance in whole pixels at `fontPx`. */
export function advancePx(ch: string, fontPx: number, weight: FigureWeight): number {
  const em = EM[ch]?.[WEIGHT_INDEX[weight]] ?? UNKNOWN_EM;
  const px = effectivePx(fontPx);
  return Math.ceil(em * px - 0.5 - 1e-9);
}

/**
 * The width of a SUPERSCRIPT's text. A footnote mark is `font-size: 0.7em` of its host and Chromium does not snap that
 * size to a whole pixel before it rounds each advance (8.4px stays 8.4: "b" at weight 400 is 5px beside a 12px host and
 * 4px beside an 11px one, where the snapped size 8 would make both 5): `advance = round(em x size)`, a half rounding
 * down. `packFigureWidth.test.ts` holds it to Chromium for marks of one and two characters.
 */
export function textPxUnsnapped(text: string, size: number, weight: FigureWeight): number {
  let px = 0;
  for (const ch of text) px += Math.ceil((EM[ch]?.[WEIGHT_INDEX[weight]] ?? UNKNOWN_EM) * size - 0.5 - 1e-9);
  return px;
}

/** The width of `text` in pixels at `fontPx`, no wrapping. */
export function textPx(text: string, fontPx: number, weight: FigureWeight): number {
  let px = 0;
  for (const ch of text) px += advancePx(ch, fontPx, weight);
  return px;
}

/** The pixel size a point size is set at. */
export const ptToPx = (pt: number): number => (pt * 96) / 72;
