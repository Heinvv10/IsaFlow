/**
 * Whether an invoice can take a write-off (AR audit C1/C2): the one rule
 * `createWriteOff` applies up front and `approveWriteOff` applies again under
 * the invoice's row lock.
 */

import type { DbRow } from '@/lib/neon';
import { documentInPopulation } from '../shared/documentPopulation';

type Row = DbRow;

/**
 * Raised when the invoice cannot take this write-off: deleted, no posted AR
 * (draft / pending_approval / cancelled) or less owing than the write-off.
 * On approval it is raised before the claim and before any write, so a route
 * may answer it with a 4xx (`withAuth` COMMITs one) and the write-off stays
 * 'draft' and cancellable.
 */
export class WriteOffInvoiceRefusedError extends Error {
  readonly code = 'WRITE_OFF_INVOICE_REFUSED';
  constructor(reason: string) {
    super(reason);
    this.name = 'WriteOffInvoiceRefusedError';
  }
}

const toCents = (n: unknown): number => Math.round(Number(n) * 100);

/** Why `inv` cannot take a write-off of `amount`, or null when it can. */
export function writeOffInvoiceRefusal(inv: Row, amount: number): string | null {
  const label = inv.invoice_number ? `Invoice ${inv.invoice_number}` : 'The invoice';
  if (inv.deleted_at) return `${label} has been deleted — it cannot be written off.`;
  if (!documentInPopulation(inv.status as string | null)) {
    return `${label} is ${inv.status ?? 'unissued'} — it has no posted receivable to write off.`;
  }
  const outstanding = toCents(inv.total_amount) - toCents(inv.amount_paid);
  if (toCents(amount) > outstanding) {
    return `Write-off amount R${Number(amount).toFixed(2)} exceeds invoice balance R${(outstanding / 100).toFixed(2)}`;
  }
  return null;
}
