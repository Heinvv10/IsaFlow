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
 * too long for the row, or one the response did not carry). Two bills can share
 * a number (it is unique per supplier, not per company), so a repeated number
 * is named once, "INV-1 (×2)", and "k more" counts BILLS, not distinct numbers.
 */
export function listNames(head: string, names: ReadonlyArray<string | undefined>, fallback: string): string {
  if (names.length === 0 || !names.every((n): n is string => !!n)) return fallback;
  const entries: Array<{ label: string; bills: number }> = [];
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const [n, bills] of counts) entries.push({ label: bills > 1 ? `${n} (×${bills})` : n, bills });
  const full = head + entries.map((e) => e.label).join(', ');
  if (full.length <= NOTICE_LINE_FITS) return full;
  for (let shown = entries.length - 1; shown >= 1; shown--) {
    const hidden = entries.slice(shown).reduce((s, e) => s + e.bills, 0);
    const cut = `${head}${entries.slice(0, shown).map((e) => e.label).join(', ')} and ${hidden} more`;
    if (cut.length <= NOTICE_LINE_FITS) return cut;
  }
  return fallback;
}
