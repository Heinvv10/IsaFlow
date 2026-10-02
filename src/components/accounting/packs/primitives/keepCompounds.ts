/**
 * A COMPOSED TITLE DOES NOT BREAK INSIDE A HYPHENATED COMPOUND.
 *
 * Chromium may break a line after any hyphen, and set Brightsphere's
 * highlights title as "non-" at the end of one line and "positive" at the
 * start of the next. The hyphen between two letters or digits is set as the
 * non-breaking hyphen (U+2011) — the same glyph in IBM Plex Sans, which
 * carries it in all three of the pack's embedded weights — so the compound
 * wraps as one word. Only on the titles the pack composes; a dash with space
 * round it, and a minus, are untouched.
 */
export function keepCompounds(text: string): string {
  return text.replace(/(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, '\u2011');
}
