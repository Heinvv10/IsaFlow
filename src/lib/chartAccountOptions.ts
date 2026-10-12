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
 * Accounts the expense-claim post route accepts (validateLeafAccount): active, of `type`, and
 * not a parent. `data` must include inactive rows, since an inactive child still makes its parent a header.
 */
export function leafAccountOptions(data: GLAccount[], type: GLAccount['accountType']): ChartAccountOption[] {
  const parents = new Set(data.map(a => a.parentAccountId).filter((p): p is string => !!p));
  return chartAccountOptions(data.filter(a => a.isActive && a.accountType === type && !parents.has(a.id)));
}
