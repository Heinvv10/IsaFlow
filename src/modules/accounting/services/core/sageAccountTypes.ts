/**
 * Sage account-mapping helpers (pure): which GL account type a Sage account type id stands for, and how alike
 * two account names are. Split from sageMigrationService.ts.
 */

const SAGE_TYPE_TO_GL: Record<number, string> = { 1: 'revenue', 2: 'expense', 5: 'asset', 6: 'liability', 7: 'equity' };

/**
 * The GL account type for a Sage `account_type` value (stored as text), or null when it has none or is not an id
 * this map knows. Only plain digits (after trim) are an id: `Number()` would also read '0x5' and '1e0'. A null is
 * "cannot place", never "any type": the caller must not auto-map such an account.
 */
export function glTypeForSageType(raw: unknown): string | null {
  const text = raw == null ? '' : String(raw).trim();
  return /^\d+$/.test(text) ? SAGE_TYPE_TO_GL[Number(text)] ?? null : null;
}

export function nameSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/[\s\-_&/]+/).filter(Boolean));
  const tokensB = new Set(b.split(/[\s\-_&/]+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
    else { for (const tb of tokensB) { if (tb.includes(t) || t.includes(tb)) { overlap += 0.5; break; } } }
  }
  return overlap / Math.max(tokensA.size, tokensB.size);
}
