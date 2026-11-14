/** Flow-bundle prices are typed in rands (WP13, audit 4.17); the API stores cents. */

/** Rands as typed ("12", "12.5", "12.50") to whole cents, from the string: no float * 100. Null if not 0+ with at most 9 integer digits and 2 decimals. */
export function randsToCents(input: string): number | null {
  // At most 9 integer digits (R999,999,999.99): well inside exact integer range for Number().
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
