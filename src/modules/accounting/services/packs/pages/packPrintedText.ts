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
 */

/** U+FE0F after a code point that is not \p{Emoji} (another selector or a mark counts as none). */
const STRAY_VS16 = /(?<!\p{Emoji})\uFE0F/gu;

/** `text` as the pack prints it. */
export function printedText(text: string): string {
  return text.includes('\uFE0F') ? text.replace(STRAY_VS16, '') : text;
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
