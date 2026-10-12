import type { GLAccount } from '@/modules/accounting/types/gl.types';

export interface ChartAccountOption { id: string; code: string; name: string }

/**
 * GET /api/accounting/chart-of-accounts answers `data` as a plain GLAccount[]
 * (camelCased accountCode / accountName), not `{ accounts: [...] }`. Maps that
 * array to the {id, code, name} option shape pickers use; anything else -> [].
 */
export function chartAccountOptions(data: GLAccount[] | undefined): ChartAccountOption[] {
  if (!Array.isArray(data)) return [];
  return data.map(a => ({ id: a.id, code: a.accountCode, name: a.accountName }));
}

/**
 * Pickers for expense-claim accounts: active accounts that are not a parent header, optionally of one
 * `type`. The post route (validateLeafAccount) refuses headers and the wrong type but does not check
 * is_active, and the add-line route only refuses inactive or foreign accounts; the UI is deliberately
 * stricter than both so an inactive account or a header is never offered. `data` must include inactive
 * rows: an inactive child still makes its parent a header to the route.
 */
export function leafAccountOptions(data: GLAccount[], type?: GLAccount['accountType']): ChartAccountOption[] {
  const parents = new Set(data.map(a => a.parentAccountId).filter((p): p is string => !!p));
  return chartAccountOptions(data.filter(a => a.isActive && (!type || a.accountType === type) && !parents.has(a.id)));
}
