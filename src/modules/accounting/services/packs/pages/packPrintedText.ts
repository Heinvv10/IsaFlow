/**
 * THE TEXT THE PACK PRINTS IS THE TEXT IT MEASURES: one rewrite of tenant text, applied where a pack's input enters
 * (`buildBoardPackPages`) and where a block is measured (`packFigureFitStamp.stampBlock`), so the fit model and the
 * printed HTML read the same characters.
 *
 * A variation selector 16 (U+FE0F) after a character with no emoji presentation ("Profit!\uFE0FTelecommunications",
 * "Directors/\uFE0F...", "-\uFE0F2024") is dropped. Chromium draws nothing for it but breaks beside it as beside no
 * character (after "!\uFE0F" before a letter, not after "-\uFE0F"): measured in production's image, a statement table
 * read a line short (#1235 round 4). After an emoji ("\u2764\uFE0F"), a keycap's digit, "#", "*", "\u00A9", "\u00AE"
 * or "\u2122" it stays: there Chromium breaks as beside the character it follows (`packBreakPairs.test.ts`).
 *
 * And the text is composed (NFC): a decomposed accent, as macOS and iOS paste it ("Cafe\u0301-2024"), is set by Chromium
 * as the composed letter, which the ruler and the pair table read as it is (#1235 round 5: production holds the break
 * in "Cafe\u0301-2024" and printed the table 666px wide; "Caf\u00E9-2024" breaks as measured).
 */

import { SELF_HOSTED } from './packFallbackWidthData';

/** U+FE0F after a code point that is not \p{Emoji} (another selector or a mark counts as none). */
const STRAY_VS16 = /(?<!\p{Emoji})\uFE0F/gu;

/**
 * `text` as the pack prints it: no stray selector, then composed (NFC). In that order: a selector between a letter and
 * its accent ("Cafe\uFE0F\u0301") blocks the composition until it is gone, and the result is NFC.
 */
export function printedText(text: string): string {
  const stripped = text.includes('\uFE0F') ? text.replace(STRAY_VS16, '') : text;
  return stripped.normalize('NFC');
}

/** Does `text` (as printed) hold a combining mark or a variation selector? */
export const carriesMarks = (text: string): boolean => /\p{M}/u.test(text);

function selfHosted(cp: number): boolean {
  let lo = 0;
  let hi = SELF_HOSTED.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = SELF_HOSTED[mid]!;
    if (cp < from) hi = mid - 1;
    else if (cp > to) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Whitespace the fill collapses (`packAnywhereLabel`, `packLineBreaks`) and the faces need not set. */
const COLLAPSED = new Set([0x09, 0x0a, 0x0d]);
/** The line and paragraph separators: the faces set them, but production holds a hyphen after one as no rule here reads (#1235 round 4, L1). */
const SEPARATORS = new Set([0x2028, 0x2029]);

/**
 * Is `text` (as printed) a row label printed to break between any two graphemes (`pack-label-anywhere`) and measured as
 * such (`packAnywhereLabel.ts`)? Where it holds a combining mark or a variation selector (`carriesMarks`), a code point
 * the pack's own faces do not set (`packFallbackWidthData.SELF_HOSTED`) or a line or paragraph separator. Only text the
 * faces set is read by the pair table: a fallback face's widths and breaks depend on the face Chromium takes, its
 * kerning and its joined forms, which no table here holds (#1235 round 9: Syriac SADHE 7.52px alone, 410px forty times
 * over; round 10: kana kerned apart in Noto Sans CJK, a run of math symbols set in its first character's face).
 */
export function printsAnywhere(text: string): boolean {
  if (carriesMarks(text)) return true;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (SEPARATORS.has(cp) || (!selfHosted(cp) && !COLLAPSED.has(cp))) return true;
  }
  return false;
}

const isPlain = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/** `value` with every string in it, through its arrays and plain objects, as `printedText`; the same value where none changes. */
export function withPrintedText<T>(value: T): T {
  if (typeof value === 'string') return printedText(value) as T;
  if (Array.isArray(value)) {
    const out = value.map((v: unknown) => withPrintedText(v));
    return (out.some((v, i) => v !== value[i]) ? out : value) as T;
  }
  if (value === null || typeof value !== 'object' || !isPlain(value)) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const next = withPrintedText(v);
    if (next !== v) changed = true;
    out[k] = next;
  }
  return (changed ? out : value) as T;
}
