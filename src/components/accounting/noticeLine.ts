/**
 * The toast clips its second line to one row of ~280px (about 45 characters),
 * so every notice keeps that line within NOTICE_LINE_FITS and puts the fact in
 * the title, which wraps (PR #688 round 5; the shared toast component is
 * not changed). Shared by the posting-warnings and late-claim notices.
 */
export const NOTICE_LINE_FITS = 45;

/**
 * `head` followed by the documents' numbers, as many as fit the line: all of
 * them, else the first few and "and k more", else `fallback` (a number alone
 * too long for the row, or one the response did not carry).
 */
export function listNames(head: string, names: ReadonlyArray<string | undefined>, fallback: string): string {
  if (names.length > 0 && names.every((n): n is string => !!n)) {
    const full = head + names.join(', ');
    if (full.length <= NOTICE_LINE_FITS) return full;
    for (let shown = names.length - 1; shown >= 1; shown--) {
      const cut = `${head}${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
      if (cut.length <= NOTICE_LINE_FITS) return cut;
    }
  }
  return fallback;
}
