/**
 * The three-way tools' refusals (budget tools PR 3): each typed refusal the three-way services raise, worded as
 * `@/lib/budgetThreeWayResponse` answers it to the app (its message, a document's issues by path, a chain's
 * reason), or null for anything else (rethrown: the registry answers it generically). Every one is raised before
 * a write or inside the save's own savepoint, so nothing it refused is kept. Also the sections a save changes.
 */
import {
  AssumptionChainError, AssumptionsDocError, CompareInputError, EngineInputError, OpeningUnbalancedError,
} from '@/modules/accounting/services/budgets/threeWay/errors';
import { AssumptionsStaleError, ThreeWayServiceError } from '@/modules/accounting/services/budgets/threeWay/serviceErrors';
import { sectionChanges } from '@/modules/accounting/services/budgets/threeWay/assumptionsRepo';
import type { StoredAssumptionsDoc } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';
import { NOT_FOUND } from './toolHelpers';

const MAX_ISSUES = 20;

export function threeWayRefusal(err: unknown): string | null {
  if (err instanceof AssumptionsStaleError) {
    return `${err.message} (the assumptions_token is now ${err.currentUpdatedAt ?? 'none: nothing is stored'})`;
  }
  if (err instanceof AssumptionsDocError) {
    const listed = err.issues.slice(0, MAX_ISSUES).map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
    return `The assumptions document is invalid: ${listed}${err.issues.length > MAX_ISSUES ? `; +${err.issues.length - MAX_ISSUES} more` : ''}`;
  }
  if (err instanceof AssumptionChainError) return `${err.message} (scenario chain: ${err.code})`;
  if (err instanceof BudgetVersionError) return err.code === 'BUDGET_VERSION_NOT_FOUND' ? NOT_FOUND : err.message;
  if (err instanceof ThreeWayServiceError || err instanceof OpeningUnbalancedError || err instanceof EngineInputError
    || err instanceof CompareInputError || err instanceof RowLockTimeoutError) return err.message;
  return null;
}

/** The document sections a save replaces (`sectionChanges`, the audit row's fields): `capex`, `overrides.vat`, … */
export function changedSections(before: StoredAssumptionsDoc | null, after: StoredAssumptionsDoc): string[] {
  return sectionChanges(before, after).map((f) => f.field.replace(/^threeWay\./, ''));
}
