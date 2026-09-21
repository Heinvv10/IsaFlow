/**
 * The expense-side journal lines for a supplier invoice. Pure — no DB — so the
 * posting shape can be proven against the real journal validator. Extracted
 * from supplierInvoiceWorkflowService.ts, which both approve paths share.
 */

import type { SupplierInvoice } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';

/**
 * Build the expense journal lines for a supplier invoice.
 *
 * Handles gross vs net line totals: if the sum of lineTotals matches
 * totalAmount (gross-inclusive storage), scale each line down to net
 * to avoid double-counting VAT. Uses a last-line adjustment so the
 * per-line rounding errors don't accumulate into a debit/credit imbalance.
 */
export function buildExpenseLines(
  invoice: SupplierInvoice,
  defaultGlAccountId: string,
): JournalLineInput[] {
  // A R0 item posts nothing, and a 0/0 journal line is refused by
  // validateJournalLine — one such bill unwound a whole bulk approve. Dropped
  // BEFORE allocation, so the rounding residual lands on the last real line:
  // dropped after, a R0 last item would carry the residual (±R0.01) alone.
  const items = (invoice.items ?? []).filter((i) => i.lineTotal !== 0);
  const sumLineTotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const lineTotalsAreGross = invoice.taxRate > 0 && Math.abs(sumLineTotal - invoice.totalAmount) < 0.02;
  const netTotal = invoice.subtotal;
  const lines: JournalLineInput[] = [];

  let allocatedNet = 0;
  const itemCount = items.length;

  items.forEach((item, idx) => {
    const glAccountId = item.glAccountId || defaultGlAccountId;
    let debit: number;

    if (idx === itemCount - 1) {
      // Last line: absorb rounding residual so debits sum exactly to subtotal.
      debit = Math.round((netTotal - allocatedNet) * 100) / 100;
    } else if (lineTotalsAreGross && sumLineTotal > 0) {
      debit = Math.round(item.lineTotal * (netTotal / sumLineTotal) * 100) / 100;
    } else {
      debit = Math.round(item.lineTotal * 100) / 100;
    }

    allocatedNet += debit;
    lines.push({
      glAccountId,
      debit,
      credit: 0,
      description: item.description,
      projectId: item.projectId || invoice.projectId,
      costCenterId: item.costCenterId || invoice.costCenterId,
    });
  });

  return lines;
}
