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

import { JOINING_FALLBACK } from './packJoiningData';

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

function joins(cp: number): boolean {
  let lo = 0;
  let hi = JOINING_FALLBACK.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = JOINING_FALLBACK[mid]!;
    if (cp < from) hi = mid - 1;
    else if (cp > to) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Is `text` (as printed) a row label printed to break between any two graphemes (`pack-label-anywhere`) and measured as
 * such (`packAnywhereLabel.ts`)? Where it holds a combining mark or a variation selector (`carriesMarks`), or a letter
 * that joins its neighbours which the pack's faces do not set (`packJoiningData.JOINING_FALLBACK`: Arabic, Syriac,
 * Mongolian, ...). Production sets such a letter in its joined form, which the fallback tables (measured alone) cannot
 * price: Syriac SADHE is 7.52px alone and 410px forty times over (#1235 round 9).
 */
export function printsAnywhere(text: string): boolean {
  if (carriesMarks(text)) return true;
  for (const ch of text) if (ch.charCodeAt(0) >= 0x600 && joins(ch.codePointAt(0)!)) return true;
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
