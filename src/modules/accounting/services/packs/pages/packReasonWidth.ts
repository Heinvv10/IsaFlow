/**
 * THE WIDTH OF A KPI TILE'S NOT-MEANINGFUL REASON, IN CSS PIXELS, AS PRODUCTION'S CHROMIUM LAYS IT OUT.
 *
 * `.pack-kpi-unavailable` is 11pt (14.667px) italic. The pack loads no italic face, so Chromium slants the regular one
 * and its advances are the regular face's: the run is shaped from the face (`packGlyphRuler.ts`). A cluster the face
 * lacks is priced from the production image's fallback fonts as this class sets them (`packFallbackWidth.ts`, style
 * `reason`): an emoji presentation at the widest emoji, never as its text glyph with a free selector.
 */
import { NEVER_SHORT, runExactPx, runPx, type Slack } from './packGlyphRuler';
import { fallbackClusterPx } from './packFallbackWidth';

/** 11pt, the class's size. */
const REASON_PX = (11 * 96) / 72;

/** `hyphen`: a line ending at a soft hyphen in `text`, with the hyphen Chromium sets there. */
export function reasonPx(text: string, hyphen = false, slack: Slack = NEVER_SHORT): number {
  return runPx(text, REASON_PX, 400, (cluster, sizePx) => fallbackClusterPx(cluster, 'reason', sizePx, sizePx), 0, hyphen, slack);
}

/** A reason line's exact advance sum, unrounded, floored once as a line (`packGlyphRuler.fitUnitsPx`). */
export function reasonExactPx(text: string, hyphen = false): number {
  if (text === '' && !hyphen) return 0;
  return runExactPx(text, REASON_PX, 400, (cluster, sizePx) => fallbackClusterPx(cluster, 'reason', sizePx, sizePx), 0, hyphen);
}
