/**
 * The account a budget write names: it must belong to the company and be a
 * revenue or expense account. Every budget reader filters to revenue and
 * expense, so a budget on any other account would be stored and then appear on
 * no report (D13). Decision 18 (Budgets P2): budgets go on leaf accounts, so a
 * NEW budget on a header (an account another account, active or not, names as
 * its parent) or on an inactive account is refused; one that already holds
 * amounts in the version (a legacy header budget) stays editable and keeps
 * reporting (P0 spec 2.6). The grid save applies the same rule (budgets/gridSave).
 */
import { sql } from '@/lib/neon';
import { BudgetInputError } from './budgetMonths';

/**
 * The account's code, or a BudgetInputError when the company may not budget it
 * in `versionId` (null: the write would create the version, so it holds nothing).
 */
export async function budgetAccountCode(companyId: string, glAccountId: string, versionId: string | null): Promise<string> {
  const [account] = (await sql`
    SELECT ga.account_code, ga.account_name, ga.account_type, ga.is_active,
           EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.company_id = ga.company_id AND ch.parent_account_id = ga.id) AS is_header,
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
