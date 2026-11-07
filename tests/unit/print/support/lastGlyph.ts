/**
 * HOW FAR A LINE'S LAST GLYPH MAY REACH PAST THE BOX IT IS SET IN: 1/64px, Chromium's layout unit.
 *
 * Chromium positions a line's glyphs at fractional advances and reports a text box on its own 1/64px grid; where the
 * box a line is set in ends between two grid points (a `1fr` grid column, a table column shared out to the subpixel),
 * the last glyph's box can end one unit past it. Nothing is drawn past the edge (the advance is inside it; the text box
 * is rounded out), so an oracle that reads text boxes against an edge allows exactly this much for an inline box and
 * nothing for a block, and an oracle that reads widths (not edges) needs no allowance. The adversary's grid (11,520 packs,
 * review of #1169/#1187) found the overrun on prose and KPI reasons ending at their row's edge, never more than this.
 */
export const LAST_GLYPH_PX = 1 / 64;
