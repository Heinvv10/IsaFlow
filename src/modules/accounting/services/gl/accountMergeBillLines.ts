/**
 * The merge repoints bill lines onto the target (`accountMergeDocumentRows`).
 * A bill still to be approved or posted is checked against the bill-line
 * account guard again at approve and Post to GL, so a line moved onto an
 * account that guard refuses — a control, bank, VAT, system or header account —
 * leaves the bill unapprovable forever. The merge refuses instead, naming the
 * bills to recode first. Bills whose journal is posted are not re-checked, so
 * their lines move freely.
 */
import { sql } from '@/lib/neon';
import { billLineAccountProblem } from '../ap/billLineAccountGuard';

const NAMED = 10;

export interface MergeTargetForBillLines {
  accountCode: string;
  accountName: string;
  accountSubtype: string | null;
  isActive: boolean;
  /** True when the target has children now, or takes the source's children in the merge. */
  willHaveChildren: boolean;
}

/** Why the merge must refuse for bill lines, or null when it may proceed. */
export async function openBillLinesRefusal(
  companyId: string, sourceId: string, sourceCode: string, target: MergeTargetForBillLines,
): Promise<string | null> {
  const problem = billLineAccountProblem({
    account_code: target.accountCode,
    account_name: target.accountName,
    account_subtype: target.accountSubtype,
    is_active: target.isActive,
    has_children: target.willHaveChildren,
  });
  if (!problem) return null;

  const rows = (await sql`
    SELECT si.invoice_number, COUNT(*) OVER () AS total
      FROM supplier_invoices si
      LEFT JOIN gl_journal_entries je
        ON je.id = si.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
     WHERE si.company_id = ${companyId}::UUID
       AND si.deleted_at IS NULL
       AND si.status <> 'cancelled'
       AND (je.id IS NULL OR je.status <> 'posted')
       AND EXISTS (SELECT 1 FROM supplier_invoice_items sii
                    WHERE sii.supplier_invoice_id = si.id AND sii.gl_account_id = ${sourceId}::UUID)
     ORDER BY si.invoice_number
     LIMIT ${NAMED}
  `) as { invoice_number: string; total: string | number }[];
  if (rows.length === 0) return null;

  const total = Number(rows[0]!.total);
  const named = rows.map((r) => r.invoice_number).join(', ');
  return `${target.accountCode} ${problem}, so bill lines may not be coded to it. `
    + `${total} bill${total === 1 ? '' : 's'} not yet approved or posted ha${total === 1 ? 's' : 've'} `
    + `lines on ${sourceCode} (${named}${total > NAMED ? ', …' : ''}); the merge would move them there and `
    + 'they could never be approved. Recode those lines or cancel the bills, then merge.';
}
