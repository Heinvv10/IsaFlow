/**
 * The account a budget write names: it must belong to the company and be a
 * revenue or expense account. Every budget reader filters to revenue and
 * expense, so a budget on any other account would be stored and then appear on
 * no report (D13). Leaf-only is the Add picker's rule, not this one: budgets on
 * header accounts exist and keep reporting (P0 spec 2.6).
 */
import { sql } from '@/lib/neon';
import { BudgetInputError } from './budgetMonths';

/** The account's code, or a BudgetInputError when the company may not budget it. */
export async function budgetAccountCode(companyId: string, glAccountId: string): Promise<string> {
  const [account] = (await sql`
    SELECT account_code, account_type FROM gl_accounts WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as Array<{ account_code: string; account_type: string }>;
  if (!account) throw new BudgetInputError('Budget account does not belong to this company');
  if (account.account_type !== 'revenue' && account.account_type !== 'expense') {
    throw new BudgetInputError('Budgets can only be set on revenue and expense accounts');
  }
  return String(account.account_code);
}
