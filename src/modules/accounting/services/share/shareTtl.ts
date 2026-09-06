/**
 * Split out of `shareParams.ts` so a browser component can use `clampTtlDays`
 * without dragging `canonicalParamsHash`'s `node:crypto` import into its
 * bundle. `shareParams.ts` re-exports this for every other existing caller —
 * only `ShareLinkDialog.tsx` needs to import it from here directly.
 */
const MAX_TTL_DAYS = 90;
const DEFAULT_TTL_DAYS = 30;

/** Clamp to [1, 90] days. A caller-supplied ttl is a convenience, not a way to
 *  mint a link that outlives the engagement. */
export function clampTtlDays(days: number | undefined): number {
  const n = Math.trunc(days ?? DEFAULT_TTL_DAYS);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TTL_DAYS;
  return Math.min(n, MAX_TTL_DAYS);
}
