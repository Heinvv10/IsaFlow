/**
 * The one check, before the write (assertMergeable) and after it (mergeAccounts,
 * on exactly the rows that moved), that the merge does not strand an open
 * document's lines on a target its line guard refuses: bill lines
 * (`accountMergeBillLines`) and customer invoice lines
 * (`accountMergeInvoiceLines`). Extracted from both callers so they cannot ask
 * different questions; throwing rolls the merge back.
 */
import { AccountMergeError } from './accountMergeError';
import { openBillLinesRefusal } from './accountMergeBillLines';
import { openInvoiceLinesRefusal } from './accountMergeInvoiceLines';
import { hasChildAccounts } from './isReportVisibleLeaf';
import type { MergeAccount } from './accountMergeGuards';

/** After the write: the line ids the merge moved, per table. Omitted before it. */
export interface MovedOpenLines {
  billLines: string[];
  invoiceLines: string[];
}

export async function assertOpenDocumentLinesMayMove(
  companyId: string, source: MergeAccount, target: MergeAccount, moved?: MovedOpenLines,
): Promise<void> {
  const willHaveChildren = (await hasChildAccounts(companyId, target.id)) || (await hasChildAccounts(companyId, source.id));
  const bills = await openBillLinesRefusal(companyId, source.id, source.accountCode,
    { ...target, willHaveChildren }, moved?.billLines);
  if (bills) throw new AccountMergeError(bills, 'target_refused_for_open_bill_lines');
  const invoices = await openInvoiceLinesRefusal(companyId, source.id, source.accountCode,
    { accountCode: target.accountCode, willHaveChildren }, moved?.invoiceLines);
  if (invoices) throw new AccountMergeError(invoices, 'target_refused_for_open_invoice_lines');
}
