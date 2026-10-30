/**
 * Headcount for one version (decision 7): payroll actives (read-only, `payrollHeadcountReader`) +
 * the version's planned hires. Both are read once; each scope (a cost centre, or null = company)
 * is computed once, on first use, by the engine's `headcountByMonth`. Counts only.
 */
import { headcountByMonth, type MonthHeadcount } from './headcount';
import { listPlannedHires } from './driverRepository';
import { readPayrollHeadcount } from './payrollHeadcountReader';

export type ScopeHeadcount = (scope: string | null) => Map<string, MonthHeadcount>;

export async function versionHeadcount(companyId: string, versionId: string, months: readonly string[]): Promise<ScopeHeadcount> {
  const { employees, allocations } = await readPayrollHeadcount(companyId);
  const hires = (await listPlannedHires(companyId, versionId))
    .map((h) => ({ costCentreId: h.costCentreId, startMonth: h.startMonth, endMonth: h.endMonth, fte: h.fte }));
  const byScope = new Map<string | null, Map<string, MonthHeadcount>>();
  return (scope) => {
    let counts = byScope.get(scope);
    if (!counts) {
      counts = headcountByMonth({ employees, allocations, hires, months, scope });
      byScope.set(scope, counts);
    }
    return counts;
  };
}
