/**
 * The account a budget write names: it must belong to the company and be a
 * revenue or expense account. Every budget reader filters to revenue and
 * expense, so a budget on any other account would be stored and then appear on
 * no report (D13). Decision 18 (Budgets P2): budgets go on leaf accounts, so a
 * NEW budget on a header (an account another account, active or not, names as
 * its parent) or on an inactive account is refused; one that already holds
 * amounts in the version (a legacy header budget) stays editable and keeps
 * reporting (P0 spec 2.6). The grid save applies the same rule (budgets/gridSave).
 *
 * "Holds amounts" is read AFTER the version is locked (`lockBudgetTarget`): read
 * before, a save that deleted the header's amounts and committed while this write
 * waited for the lock would still exempt it.
 */
import { sql } from '@/lib/neon';
import { writeVersion } from '../budgets/budgetVersionScope';
import { BudgetVersionError } from '../budgets/budgetVersionTypes';
import { BudgetInputError } from './budgetMonths';

/**
 * Decision 18's header test as a `sql` fragment: the `gl_accounts` row aliased `ga` is named as
 * `parent_account_id` by another account of its company, active or not (the leafAccountOptions rule).
 * Built per call, not at import, so a unit test's `vi.mock('@/lib/neon')` is never called while modules load.
 */
export const isHeaderSql = () => sql`EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.company_id = ga.company_id AND ch.parent_account_id = ga.id)`;

/** The account's code, or a BudgetInputError when the company may not budget it in `versionId`. */
async function budgetAccountCode(companyId: string, glAccountId: string, versionId: string): Promise<string> {
  const [account] = (await sql`
    SELECT ga.account_code, ga.account_name, ga.account_type, ga.is_active, ${isHeaderSql()} AS is_header,
           EXISTS (SELECT 1 FROM budget_month_amounts bm
                    WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID AND bm.gl_account_id = ga.id) AS holds
      FROM gl_accounts ga WHERE ga.id = ${glAccountId}::UUID AND ga.company_id = ${companyId}::UUID
  `) as Array<{ account_code: string; account_name: string | null; account_type: string; is_active: boolean; is_header: boolean; holds: boolean }>;
  if (!account) throw new BudgetInputError('Budget account does not belong to this company');
  if (account.account_type !== 'revenue' && account.account_type !== 'expense') {
    throw new BudgetInputError('Budgets can only be set on revenue and expense accounts');
  }
  const label = `${account.account_code} ${account.account_name ?? ''}`.trim();
  if (!account.holds && account.is_header) {
    throw new BudgetInputError(`Account ${label} is a header account: budget its sub-accounts instead`);
  }
  if (!account.holds && !account.is_active) {
    throw new BudgetInputError(`Account ${label} is inactive: a new budget cannot be set on it`);
  }
  return String(account.account_code);
}

/**
 * Locks the version a company-level write of `glAccountId` goes to (`writeVersion`: the named one
 * or the year's primary, created as a draft 'Original' when missing), then checks the account
 * (decision 18) and that the version does not budget it by dimension. Run it inside a savepoint:
 * a refusal here comes after the lock bumped the token (and maybe created the primary), and the
 * 4xx it becomes is committed by withAuth.
 */
export async function lockBudgetTarget(
  companyId: string, fiscalYear: number, glAccountId: string, versionId: string | undefined, userId: string,
): Promise<{ id: string; isPrimary: boolean; accountCode: string }> {
  const target = await writeVersion(companyId, fiscalYear, versionId, userId);
  const accountCode = await budgetAccountCode(companyId, glAccountId, target.id);
  const otherGrain = (await sql`
    SELECT 1 FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${target.id}::UUID
       AND gl_account_id = ${glAccountId}::UUID AND dim_grain <> 0
     LIMIT 1
  `) as unknown[];
  if (otherGrain.length > 0) {
    throw new BudgetVersionError('BUDGET_GRAIN_CONFLICT',
      `Account ${accountCode} is budgeted by dimension in this version; it cannot also have a company-level budget`);
  }
  return { ...target, accountCode };
}
