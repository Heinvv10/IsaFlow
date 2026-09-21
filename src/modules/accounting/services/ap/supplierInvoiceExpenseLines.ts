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
  const items = invoice.items ?? [];
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

  return dropValuelessLines(lines);
}

/**
 * validateJournalLine refuses a 0/0 line and a negative debit, and one such
 * bill unwinds a whole bulk approve. Allocation above is left EXACTLY as it
 * was — the last item keeps carrying the residual, on its own account and
 * dimensions, even when it is a R0 item (an unread price from the capture
 * pipeline carries the whole subtotal that way). Only afterwards:
 *
 *   - a last line that is a sub-cent-per-line NEGATIVE rounding overshoot is
 *     folded into the largest line (ties → the later one). It is rounding, not
 *     value. A larger negative is inconsistent data (Σ lines > subtotal) and is
 *     left for the validator to refuse: folding it would re-dimension real value.
 *   - a line that comes out at exactly R0.00 is dropped. It carries nothing.
 */
function dropValuelessLines(lines: JournalLineInput[]): JournalLineInput[] {
  const last = lines[lines.length - 1];
  const roundingTolerance = lines.length * 0.01;
  if (last && last.debit < 0 && -last.debit <= roundingTolerance + 1e-9) {
    let largest = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      if (largest === -1 || lines[i]!.debit >= lines[largest]!.debit) largest = i;
    }
    if (largest !== -1) {
      const target = lines[largest]!;
      target.debit = Math.round((target.debit + last.debit) * 100) / 100;
      last.debit = 0;
    }
  }
  return lines.filter((l) => l.debit !== 0);
}
