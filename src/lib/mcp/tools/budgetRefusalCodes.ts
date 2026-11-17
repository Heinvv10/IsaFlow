/**
 * Budget version and grid-save refusal codes an MCP tool may show an agent verbatim (spread into
 * `refusalCodes.ts`, which is over the 300-line cap). `BudgetVersionError` (budgets/budgetVersionTypes)
 * carries its code as a constructor argument, so the census in typedRefusalReachesAgent cannot see it:
 * this list is the decision. The messages are the ones the budget routes already answer as 4xx and name
 * only the caller's own version, accounts, members and months. Thrown from a tool, the registry's
 * savepoint has rolled everything back before the message is shown (MCP budget tools, 2026-11-16).
 */
import type { BudgetVersionErrorCode } from '@/modules/accounting/services/budgets/budgetVersionTypes';

export const BUDGET_REFUSAL_CODES: readonly BudgetVersionErrorCode[] = [
  'BUDGET_VERSION_LOCKED',
  'BUDGET_VERSION_STALE',
  'BUDGET_VERSION_STATE',
  'BUDGET_VERSION_FORBIDDEN',
  'BUDGET_VERSION_NOT_FOUND',
  'BUDGET_GRAIN_CONFLICT',
  'BUDGET_VERSION_INPUT',
  'BUDGET_SLICE_LOCKED',
  'BUDGET_SLICE_FORBIDDEN',
  'BUDGET_SLICE_STATE',
  'BUDGET_SLICE_NOT_FOUND',
  'BUDGET_SLICES_PENDING',
  'BUDGET_SLICE_DRIVER',
];
