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
  const debits = expenseLineNets(items, invoice);
  const lines: JournalLineInput[] = [];
  items.forEach((item, idx) => {
    const debit = debits[idx]!;
    if (debit === 0) return; // a line that comes out at exactly R0.00 carries nothing (see expenseLineNets)
    lines.push({
      glAccountId: item.glAccountId || defaultGlAccountId,
      debit,
      credit: 0,
      description: item.description,
      projectId: item.projectId || invoice.projectId,
      // The legacy pick; placeCostCentres puts it in cc1 / cc2 before posting (gl/dimensions/costCentrePick).
      costCenterId: item.costCenterId || invoice.costCenterId,
      // The canonical analysis dimensions ride on the EXPENSE leg only; the
      // AP and VAT legs the workflow adds carry none (brief §5.3).
      ...(item.cc1Id ? { cc1Id: item.cc1Id } : {}),
      ...(item.cc2Id ? { cc2Id: item.cc2Id } : {}),
      ...(item.buId ? { buId: item.buId } : {}),
    });
  });
  return lines;
}

/**
 * Each item's posted expense debit, in item order (0: the line is dropped). Pure; `buildExpenseLines` posts exactly
 * these, and the slip-dimension matcher (`supplierInvoiceProvisionalDims`) matches against them.
 */
export function expenseLineNets(
  items: readonly { lineTotal: number }[],
  header: { subtotal: number; totalAmount: number; taxRate: number },
): number[] {
  const sumLineTotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const lineTotalsAreGross = header.taxRate > 0 && Math.abs(sumLineTotal - header.totalAmount) < 0.02;
  const netTotal = header.subtotal;
  const debits: number[] = [];

  let allocatedNet = 0;
  const itemCount = items.length;

  items.forEach((item, idx) => {
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
    debits.push(debit);
  });

  // Only a SCALED (gross) allocation rounds, and only when the last item is
  // not itself negative: net line totals are NUMERIC(15,2), so in net storage
  // any negative residual is inconsistent data, and a negative last ITEM is a
  // real discount line whose own account and project must not be merged away.
  const lastItem = items[itemCount - 1];
  const residualIsRounding = lineTotalsAreGross && lastItem !== undefined && lastItem.lineTotal >= 0;
  foldRoundingOvershoot(debits, residualIsRounding);
  return debits;
}

/**
 * validateJournalLine refuses a 0/0 line and a negative debit, and one such
 * bill unwinds a whole bulk approve. Allocation above is left EXACTLY as it
 * was — the last item keeps carrying the residual, on its own account and
 * dimensions, even when it is a R0 item (an unread price from the capture
 * pipeline carries the whole subtotal that way). Only afterwards:
 *
 *   - when the residual can only be rounding (`residualIsRounding`), a last
 *     line that is a sub-cent-per-line NEGATIVE overshoot is folded into the
 *     largest line (ties → the later one). Otherwise a negative last line is
 *     real value or bad data and is left for the validator to refuse: folding
 *     it would re-dimension it onto another account and project.
 *   - a line that comes out at exactly R0.00 is dropped. It carries nothing.
 */
function foldRoundingOvershoot(debits: number[], residualIsRounding: boolean): void {
  const lastIdx = debits.length - 1;
  const last = debits[lastIdx];
  const roundingTolerance = debits.length * 0.01;
  if (residualIsRounding && last !== undefined && last < 0 && -last <= roundingTolerance + 1e-9) {
    let largest = -1;
    for (let i = 0; i < lastIdx; i++) {
      if (largest === -1 || debits[i]! >= debits[largest]!) largest = i;
    }
    if (largest !== -1) {
      debits[largest] = Math.round((debits[largest]! + last) * 100) / 100;
      debits[lastIdx] = 0;
    }
  }
}
