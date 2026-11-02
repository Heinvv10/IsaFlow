/**
 * The wire type of `/api/accounting/reports-budget-comparator`, projected off the service
 * (see apiRoutes.ts: never hand-write a shape, take it from the function). Kept beside the
 * registry so the registry stays under the file-size limit. Every import is `import type`.
 */
import type { BudgetVarianceTrackedResult, getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';

export interface BudgetComparatorResponse {
  fiscalYear: Awaited<ReturnType<typeof getBudgetVariance>>['fiscalYear'];
  monthKeys: Awaited<ReturnType<typeof getBudgetVariance>>['monthKeys'];
  lines: BudgetVarianceTrackedResult['lines'];
  /** `result.rows.length` — how many accounts the SERVICE classified as
   *  budgeted. Derived in the handler, so it is written out here rather
   *  than projected off the service type; it is a count of that array and
   *  moves with it. */
  budgetedCount: number;
  postedThrough: Awaited<ReturnType<typeof getBudgetVariance>>['postedThrough'];
  version: BudgetVarianceTrackedResult['version'];
  unallocatedBudget: BudgetVarianceTrackedResult['unallocatedBudget'];
  budgetAbsentYears: BudgetVarianceTrackedResult['budgetAbsentYears'];
  budgetOutsideFilterYears: BudgetVarianceTrackedResult['budgetOutsideFilterYears'];
  splitsMonth: BudgetVarianceTrackedResult['splitsMonth'];
  partialBudgetCount: BudgetVarianceTrackedResult['partialBudgetCount'];
  bands: BudgetVarianceTrackedResult['bands'];
}
