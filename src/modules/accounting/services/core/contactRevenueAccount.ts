/**
 * A customer's default revenue account (migration 965): the account a new invoice line for the customer starts on.
 * Judged here, before the create or update writes anything (a refused request must change no row: a 4xx commits the
 * request's transaction). It must be:
 *  - this company's (the composite FK refuses another tenant's id too; this says so by name instead of a 23503);
 *  - one an invoice line may credit: revenue, a leaf, active (`revenueLineAccountProblem`, the invoice line guard's own
 *    rule, so a default can never be an account the invoice save would then refuse);
 *  - not one that can never carry VAT (`classifyNonSupplyAccount`: interest, dividends and the like are not a supply).
 * A blank value means none. The invoice line guard re-checks the account when an invoice names it, so an account
 * deactivated after it was chosen is refused there, not posted.
 */
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { revenueLineAccountProblem, type RevenueLineAccountRow } from '../ar/invoiceLineCodingGuard';
import { NON_SUPPLY_LABEL, classifyNonSupplyAccount } from '../gl/nonSupplyAccounts';
import { ContactValidationError } from './contactValidationError';

const FIELD = 'default_revenue_account_id';

/** Why this account cannot be a customer's default revenue account, or null when it can. */
export function customerRevenueAccountProblem(a: RevenueLineAccountRow): string | null {
  const lineProblem = revenueLineAccountProblem(a);
  if (lineProblem) return lineProblem;
  const reason = classifyNonSupplyAccount(a.account_name);
  return reason ? `can never carry VAT (${NON_SUPPLY_LABEL[reason].toLowerCase()})` : null;
}

/** The id to store, null for none, or a ContactValidationError naming the account. Runs no SQL for a blank value. */
export async function customerRevenueAccount(companyId: string, accountId: string | null | undefined): Promise<string | null> {
  const id = typeof accountId === 'string' ? accountId.trim() : '';
  if (!id) return null;
  if (!UUID_RE.test(id)) throw new ContactValidationError(`${FIELD} must be a GL account id`);
  const rows = (await sql`
    SELECT a.account_code, a.account_name, a.account_type, a.is_active,
           EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
    FROM gl_accounts a
    WHERE a.id = ${id}::UUID AND a.company_id = ${companyId}::UUID
  `) as RevenueLineAccountRow[];
  const account = rows[0];
  if (!account) throw new ContactValidationError(`${FIELD} ${id} is not one of this company's accounts`);
  const problem = customerRevenueAccountProblem(account);
  if (problem) {
    throw new ContactValidationError(
      `${account.account_code} ${account.account_name} cannot be a customer's default revenue account: it ${problem}`);
  }
  return id;
}
