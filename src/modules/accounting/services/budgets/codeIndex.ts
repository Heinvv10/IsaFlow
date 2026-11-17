/**
 * Code matching for budget rows (moved unchanged out of budgetImportResolve.ts so the MCP budget tools resolve
 * codes with the SAME rule without loading the Excel modules): a code matches EXACTLY first (as the chart
 * holds it), and trimmed only when the trimmed form belongs to one item alone (VER-L6).
 */

/** A code's owner: the item, null when the code (or its trimmed form) belongs to more than one, undefined when to none. */
export type Find<T> = (code: string) => T | null | undefined;

export function codeIndex<T extends { code: string }>(items: readonly T[]): Find<T> {
  const exact = new Map<string, T | null>();
  const trimmed = new Map<string, T | null>();
  for (const item of items) {
    exact.set(item.code, exact.has(item.code) ? null : item);
    const t = item.code.trim();
    trimmed.set(t, trimmed.has(t) ? null : item);
  }
  return (code) => (exact.has(code) ? exact.get(code) : trimmed.get(code.trim()));
}
