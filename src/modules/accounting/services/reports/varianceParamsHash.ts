/**
 * The key a budget variance note is filed under in `report_commentary` (budgets P5 spec §3e):
 * `params_hash = sha256('bva|' || version_id || '|' || month)` with the month as 'YYYY-MM', and the
 * row's `period_start` / `period_end` the month's first and last day.
 *
 * Beside `packParamsHash.ts` and kept apart from it on purpose: `PACK_TYPES` and
 * `canonicalParamsHash` describe report PACKS, and `commentaryBudget.printsOnFixedPage` recovers a pack
 * type by matching against them. A variance note is not a pack; its rows carry
 * `report_kind = 'budget_variance'` and no pack reader selects that kind.
 *
 * SERVER ONLY (`node:crypto`), like `packParamsHash.ts`.
 */
import { createHash } from 'node:crypto';

/** sha256 over 'bva|<version id, lower case>|<YYYY-MM>'. */
export function varianceParamsHash(versionId: string, month: string): string {
  return createHash('sha256').update(`bva|${versionId.toLowerCase()}|${month}`).digest('hex');
}

/** The first and last day of a 'YYYY-MM' month, as 'YYYY-MM-DD'. */
export function varianceMonthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}
