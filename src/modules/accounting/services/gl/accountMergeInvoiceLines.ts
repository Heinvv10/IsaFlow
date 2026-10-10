/**
 * The merge repoints customer invoice lines onto the target
 * (`accountMergeDocumentRows`). An invoice still to be approved or posted is
 * checked against the invoice-line coding guard again at approve and Post to
 * GL (`ar/invoiceLineCodingGuard`), which refuses a header account — so a line
 * moved onto a target that is, or becomes, a header (it takes the source's
 * children) leaves the invoice unapprovable until recoded. The merge refuses
 * instead, naming the invoices to recode first: `accountMergeBillLines`, for
 * invoice lines. Invoices whose journal is posted are not re-checked, so their
 * lines move freely.
 *
 * Only the header case: the merge already refuses an inactive target and an
 * account-type change, so a line acceptable on the source stays acceptable on
 * any other target the merge allows.
 */
import { sql } from '@/lib/neon';

const NAMED = 10;

export interface MergeTargetForInvoiceLines {
  accountCode: string;
  /** True when the target has children now, or takes the source's children in the merge. */
  willHaveChildren: boolean;
}

/** Why the merge must refuse for invoice lines, or null when it may proceed. */
export async function openInvoiceLinesRefusal(
  companyId: string, sourceId: string, sourceCode: string, target: MergeTargetForInvoiceLines,
  /** After the write: only the invoice-line ids the merge actually moved. */
  movedItemIds?: string[],
): Promise<string | null> {
  if (!target.willHaveChildren) return null;

  const rows = (await sql`
    SELECT ci.invoice_number, COUNT(*) OVER () AS total
      FROM customer_invoices ci
      LEFT JOIN gl_journal_entries je
        ON je.id = ci.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
     WHERE ci.company_id = ${companyId}::UUID
       AND ci.deleted_at IS NULL
       AND ci.status <> 'cancelled'
       AND (je.id IS NULL OR je.status <> 'posted')
       AND EXISTS (SELECT 1 FROM customer_invoice_items cii
                    WHERE cii.invoice_id = ci.id
                      AND (${movedItemIds ?? null}::UUID[] IS NULL
                           AND cii.gl_account_id = ${sourceId}::UUID
                           OR cii.id = ANY(${movedItemIds ?? null}::UUID[])))
     ORDER BY ci.invoice_number
     LIMIT ${NAMED}
  `) as { invoice_number: string; total: string | number }[];
  if (rows.length === 0) return null;

  const total = Number(rows[0]!.total);
  const named = rows.map((r) => r.invoice_number).join(', ');
  return `${target.accountCode} is or would become a header account with sub-accounts, so invoice lines may not be coded to it. `
    + `${total} customer invoice${total === 1 ? '' : 's'} not yet approved or posted ha${total === 1 ? 's' : 've'} `
    + `lines on ${sourceCode} (${named}${total > NAMED ? ', …' : ''}); the merge would move them there and `
    + 'they could never be approved. Recode those lines or cancel the invoices, then merge.';
}
