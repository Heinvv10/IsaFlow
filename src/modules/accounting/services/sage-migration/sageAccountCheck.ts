/**
 * --po-gl-account must name an account every PO line may be posted to: an ACTIVE, non-header EXPENSE account of THIS company.
 * Checked before the dry run, so a revenue, asset, liability (AP), equity or header account, an inactive or another company's
 * account, never reaches the budget check as the account the whole import is judged on. A header is an account with children.
 */
import { sql } from '@/lib/neon';
import { OwnError } from './sageTold';

export class PoGlAccountError extends OwnError {}

export async function assertPoGlAccount(companyId: string, accountId: string): Promise<void> {
  const rows = (await sql`
    SELECT a.account_code, a.account_name, a.account_type, a.is_active,
           EXISTS (SELECT 1 FROM gl_accounts c WHERE c.company_id = a.company_id AND c.parent_account_id = a.id) AS is_header
      FROM gl_accounts a WHERE a.company_id = ${companyId}::UUID AND a.id = ${accountId}::UUID
  `) as Array<{ account_code: string; account_name: string; account_type: string; is_active: boolean; is_header: boolean }>;
  const a = rows[0];
  if (!a) throw new PoGlAccountError(`--po-gl-account ${accountId} is not a GL account of this company`);
  const name = `${a.account_code} ${a.account_name}`;
  if (a.account_type !== 'expense') throw new PoGlAccountError(`--po-gl-account ${name} is of type ${a.account_type}: PO lines post to an expense account`);
  if (!a.is_active) throw new PoGlAccountError(`--po-gl-account ${name} is inactive`);
  if (a.is_header) throw new PoGlAccountError(`--po-gl-account ${name} is a header account (it has child accounts): PO lines post to a postable account`);
}
