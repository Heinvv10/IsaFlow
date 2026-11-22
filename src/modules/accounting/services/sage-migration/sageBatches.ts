/** Batching and the deterministic idempotency keys of a migration run. PURE. */
import { createHash } from 'node:crypto';

/** Items go 500 to a call (bulk_upsert_items), purchase orders 100 (bulk_create_purchase_orders). */
export const MAX_ITEM_BATCH = 500;
export const MAX_PO_BATCH = 100;

export function chunk<T>(rows: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`batch size must be a positive integer (got ${size})`);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * The same rows in the same batch position always get the same key, so a re-run replays instead of repeating; changed rows
 * get a different key (the tools' own external_ref idempotency then decides what is new). 1-based `n`.
 */
export function batchKey(entity: string, n: number, args: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
  return `sage-mig-${entity}-${String(n).padStart(4, '0')}-${hash}`;
}

/** Stable batch composition: rows ordered by their key, numeric ids numerically. */
export function byStableKey<T>(rows: readonly T[], keyOf: (r: T) => string): T[] {
  const num = (s: string) => (/^\d+$/.test(s) ? BigInt(s) : null);
  return [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    const na = num(ka);
    const nb = num(kb);
    if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
