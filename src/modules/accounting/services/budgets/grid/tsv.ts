/**
 * The grid's copy format: tab-separated, one line per row, a trailing newline
 * (as Excel writes it), raw `1234.50` with no separators, and an empty field
 * for an unbudgeted cell (never `0`). `parseClipboard` reads it back exactly.
 */

/** Integer cents → `-1234.50`. Integer arithmetic only, so no float noise. */
export function centsToPlain(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Not whole cents: ${cents}`);
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `-${text}` : text;
}

export function toTsv(matrix: readonly (readonly (number | null)[])[]): string {
  return matrix.map(row => row.map(c => (c === null ? '' : centsToPlain(c))).join('\t')).join('\n') + '\n';
}
