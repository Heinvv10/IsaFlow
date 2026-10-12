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
