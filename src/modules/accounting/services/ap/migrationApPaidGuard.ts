/**
 * The take-on importer's over-payment refusal for a supplier bill.
 *
 * A bill stored paid beyond its total carries a negative `balance` that every AP
 * aggregate sums, and nothing downstream clamps it. The AR importer refuses the
 * same row (migration 899 backs that with a CHECK); this is the AP twin, in whole
 * cents with no tolerance like every supplier-side over-payment guard
 * (`billAllocatable.toCents`). The excess is a credit the supplier owes the
 * company, not part of this bill.
 */

import type { MigrationError } from '../core/migrationService';
import { toCents } from './billAllocatable';

export function paidBeyondTotal(
  inv: { invoiceNumber: string; totalAmount: number; amountPaid?: number },
  row: number,
): MigrationError | null {
  const paid = inv.amountPaid ?? 0;
  if (toCents(paid) <= toCents(inv.totalAmount)) return null;
  return {
    step: 'ap_invoices', row, field: 'amountPaid',
    message: `${inv.invoiceNumber} is paid ${paid.toFixed(2)}, which exceeds its total of ${inv.totalAmount.toFixed(2)}. `
      + 'Import it at its total and load the excess as a supplier credit note or refund.',
  };
}
