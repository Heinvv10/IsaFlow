/**
 * THE WIDTH OF A PRINTED FIGURE OR A 9pt LABEL, IN CSS PIXELS, AS PRODUCTION'S CHROMIUM LAYS IT OUT.
 *
 * Measured, not estimated. The pack sets its figures and labels in its self-hosted IBM Plex Sans at three weights,
 * and production's Chromium (Gotenberg's) positions glyphs at fractional advances: the run is shaped from the face
 * itself, kerning and `tnum` included, at the size floored to 1/64px, and rounded up to Chromium's 1/64px unit
 * (`packGlyphRuler.ts`, held to Chromium by `packGlyphRuler.test.ts`). A cluster the face lacks is priced from the
 * production image's own fallback fonts (`packFallbackWidth.ts`, measured at the 9pt label; scaled to other sizes and
 * rounded up). There is no whole-pixel rounding of each advance any more: that was the test browser's, not production's.
 */
import { NEVER_SHORT, runPx, type FaceWeight, type Slack } from './packGlyphRuler';
import { fallbackClusterPx, type FallbackStyle } from './packFallbackWidth';

/** Weights the pack sets figures in: a line row, a subtotal row (and every KPI figure), a total row. */
export type FigureWeight = FaceWeight;

/** The 9pt label the fallback tables are measured at. */
const LABEL_PX = 12;
const LABEL_STYLE: Readonly<Record<FigureWeight, FallbackStyle>> = { 400: 'label400', 500: 'label500', 600: 'label600' };

/**
 * The width of `text` in pixels at `fontPx` and `weight`, no wrapping: never short, at most 1/32px over in the face.
 * `hyphen`: a line ending at a soft hyphen in it, with the hyphen Chromium sets there (`packLineBreaks.Piece.hyphen`).
 * `slack`: `packGlyphRuler.Slack` (never short, unless a layout model asks for the width as Chromium sets it).
 */
export function textPx(text: string, fontPx: number, weight: FigureWeight, hyphen = false, slack: Slack = NEVER_SHORT): number {
  return runPx(text, fontPx, weight, (cluster, sizePx) => fallbackClusterPx(cluster, LABEL_STYLE[weight], sizePx, LABEL_PX), 0, hyphen, slack);
}

/**
 * The width of a SUPERSCRIPT's text. A footnote mark is `font-size: 0.7em` of its host: Chromium floors that size to
 * 1/64px like any other (8.4px is set at 8.390625), so this is `textPx` at that size; the name says the size is not a
 * whole pixel.
 */
export function textPxUnsnapped(text: string, size: number, weight: FigureWeight, slack: Slack = NEVER_SHORT): number {
  return textPx(text, size, weight, false, slack);
}

/** The pixel size a point size is set at. */
export const ptToPx = (pt: number): number => (pt * 96) / 72;
