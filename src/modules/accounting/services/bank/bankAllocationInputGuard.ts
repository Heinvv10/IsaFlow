/**
 * The two input refusals `createJournalEntry` used to raise for an allocation or a split — as plain Errors, after
 * the request had started writing: a GL account of another company (or none), and a cost centre / business unit that
 * is inactive, in the wrong slot or not this company's.
 *
 * `withAuth` rolls back a 5xx, so a plain Error was right for a fault but wrong for the caller's input: a
 * non-existent cost centre answered 500. Decided HERE, from reads, before the first write, and typed
 * (`BankAllocationRefusal`, 400), with the same rule and text the journal writer applies
 * (`journalAnalysisDimensionProblem`, `accountsBelongToCompany`) — so a line this passes cannot fail them later.
 */
import { accountsBelongToCompany } from '../gl/chartOfAccountsService';
import { journalAnalysisDimensionProblem } from '../gl/journalCostCentreValidation';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';
import { BankAllocationRefusal } from './bankAllocationRefusal';

/** Throws a BankAllocationRefusal unless every account is this company's and every dimension is assignable. */
export async function assertAllocationInputUsable(
  companyId: string, accountIds: readonly string[], dimensions: readonly DimensionIds[],
): Promise<void> {
  if (!(await accountsBelongToCompany(companyId, [...accountIds]))) {
    throw new BankAllocationRefusal('One or more journal lines name a GL account outside this company');
  }
  const problem = await journalAnalysisDimensionProblem(companyId, dimensions);
  if (problem !== null) throw new BankAllocationRefusal(problem);
}
