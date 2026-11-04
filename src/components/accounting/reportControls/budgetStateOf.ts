/**
 * The one precedence for what a comparator fetch has established, shared by the
 * statement pages' hook and the presentation deck so the two cannot disagree:
 * not asked → failed → limited → refused → still in flight / not landed → none → available.
 */
import { hasBudgetData } from '@/modules/accounting/services/reports/statementRows/comparators';
import type { BudgetState } from './useStatementComparators';

export interface BudgetStateInputs {
  /** The budget column was asked for. */
  requested: boolean;
  failed: boolean;
  limited: boolean;
  refused: boolean;
  /** The comparator's `budgetedCount`; null while the response has not landed. */
  budgetedCount: number | null;
}

export function budgetStateOf(i: BudgetStateInputs): BudgetState {
  if (!i.requested) return 'unknown';
  if (i.failed) return 'failed';
  if (i.limited) return 'limited';
  if (i.refused) return 'refused';
  if (i.budgetedCount === null) return 'unknown';
  return hasBudgetData(i.budgetedCount) ? 'available' : 'none';
}
