/**
 * THE WIDTH OF A KPI TILE'S NOT-MEANINGFUL REASON, IN DEVICE PIXELS, AS CHROMIUM LAYS IT OUT.
 *
 * `.pack-kpi-unavailable` is 11pt (14.667px) italic, and the pack's italic cut of IBM Plex Sans is a real face with its
 * own advances ("nnnnnnnnnnnnnnnnnnnn" is 160px in it and 180px in the regular face the figure ruler uses at 15px). A
 * glyph's advance is a whole number of pixels at this size, measured between two bars through the class itself. The
 * tables are generated (`packReasonWidthData.ts`, which says how to regenerate them):
 *  - one by one: U+0020 to U+017F (Basic Latin, Latin-1, Latin Extended-A), U+0180 to U+04FF (Latin Extended-B to
 *    Cyrillic), U+1E00 to U+2BFF (Latin Extended Additional, Greek Extended, punctuation, currency, letterlike
 *    symbols, arrows, mathematical operators, technical, box drawing, shapes, symbols, dingbats) and U+1D400 to
 *    U+1D7FF (mathematical alphanumerics);
 *  - every other block of 32 code points up to U+1FFFF by the WIDEST glyph in it: an upper bound for any glyph of the
 *    block, not a measure of it (CJK, Hangul, emoji, the scripts of the world). An Arabic ligature sign is 106px
 *    (U+FDFD), so the blocks are not a flat 18;
 *  - beyond U+1FFFF, 18px.
 * Glyphs outside the self-hosted face are set in the machine's fallback fonts, so those entries hold only where the
 * fonts are the ones measured. The joiner and the variation selectors add nothing to their base glyph (a heart is 18px
 * with or without one, a three-person family 18px in all): they are charged 0 and their base glyph its width.
 * `packFigureWidth.test.ts` re-measures the entries and fails if one drifts.
 */
import { BLOCKS_ASTRAL, BLOCKS_BMP_HIGH, BLOCKS_LOW, EXACT, LATIN, WIDE_BLOCKS } from './packReasonWidthData';

const WIDEST_PX = 18;
/** U+200D (joiner) and U+FE0E/FE0F (variation selectors) combine with the glyph before them. */
const ZERO_WIDTH = new Set([0x200d, 0xfe0e, 0xfe0f]);
const BLOCK = 32;

const digit = (table: string, index: number): number => Number.parseInt(table[index]!, 36);

function blockWidth(table: string, base: number, code: number): number {
  const index = (code - base) >> 5;
  const wide = WIDE_BLOCKS[base + index * BLOCK];
  return wide ?? digit(table, index);
}

function advance(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (ZERO_WIDTH.has(code)) return 0;
  let px: number;
  if (code >= 0x20 && code <= 0x17f) px = LATIN[code - 0x20]!;
  else if (code >= 0x180 && code <= 0x4ff) px = digit(EXACT, code - 0x180);
  else if (code >= 0x1e00 && code <= 0x2bff) px = digit(EXACT, 0x380 + code - 0x1e00);
  else if (code >= 0x1d400 && code <= 0x1d7ff) px = digit(EXACT, 0x380 + 0xe00 + code - 0x1d400);
  else if (code >= 0x500 && code <= 0x1dff) px = blockWidth(BLOCKS_LOW, 0x500, code);
  else if (code >= 0x2c00 && code <= 0xffff) px = blockWidth(BLOCKS_BMP_HIGH, 0x2c00, code);
  else if (code >= 0x10000 && code <= 0x1ffff) px = blockWidth(BLOCKS_ASTRAL, 0x10000, code);
  else px = WIDEST_PX;
  // A combining mark advances nothing; anything else the table holds as 0 is a control or unassigned: the widest.
  if (px === 0) return /\p{M}/u.test(ch) ? 0 : WIDEST_PX;
  return px;
}

export function reasonPx(text: string): number {
  let px = 0;
  for (const ch of text) px += advance(ch);
  return px;
}
