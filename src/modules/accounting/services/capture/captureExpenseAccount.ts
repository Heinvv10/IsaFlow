/**
 * The GL expense account a capture-inbox expense post books to.
 *
 * Split out of `pages/api/accounting/capture/[id]/post-expense.ts` (K-072
 * round 18), which had grown past the 300-line cap. The three branches, their
 * statements and their order are the route's, unchanged:
 *   - an account the caller named, verified to belong to this company — null
 *     when it does not, which the route answers 400;
 *   - otherwise a merchant-pattern match on the vendor name;
 *   - otherwise the company's `default_expense` role.
 */
import { sql } from '@/lib/neon';
import {
  mapMerchantToExpenseAccount,
  type ReceiptAccountMapping,
} from '@/modules/accounting/services/bank/receiptToJournalService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';

type Row = Record<string, unknown>;

export async function resolveCaptureExpenseAccount(
  companyId: string,
  bodyGlAccountId: string | undefined,
  vendorName: string | null | undefined,
): Promise<string | null> {
  if (bodyGlAccountId) {
    // Caller specified explicit GL account — verify it belongs to this company
    const acctRows = await sql`
      SELECT id FROM gl_accounts
      WHERE id = ${bodyGlAccountId}::uuid AND company_id = ${companyId}
      LIMIT 1
    ` as Row[];
    return acctRows.length === 0 ? null : bodyGlAccountId;
  }
  if (vendorName) {
    // Try merchant-pattern lookup
    const allAccts = await sql`
      SELECT id, account_code AS code, account_name AS name
      FROM gl_accounts
      WHERE company_id = ${companyId}
        AND is_active = true
    ` as Row[];
    const mappings: ReceiptAccountMapping[] = allAccts.map(a => ({
      id: a.id as string,
      code: a.code as string,
      name: a.name as string,
    }));
    const suggestion = mapMerchantToExpenseAccount(vendorName, mappings);
    return suggestion?.id ?? await getSystemAccountId('default_expense', companyId);
  }
  return getSystemAccountId('default_expense', companyId);
}
