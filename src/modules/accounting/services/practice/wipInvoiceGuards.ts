/**
 * Refusals for a WIP invoice (R-120), checked before anything is written.
 *
 * The WIP route used to answer every error with "WIP invoice failed", so an
 * operator whose invoice was refused had nothing to act on — and two shapes
 * were not refused at all: a tax rate over 100 booked, and a negative time
 * entry inside a positive selection became a credit embedded in a sale.
 */
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/types/db';

/**
 * A WIP invoice the operator asked for and cannot have, with the reason they
 * can act on. The route answers it 400 with this message; anything else is a
 * fault and stays a 500.
 */
export class WipInvoiceRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WipInvoiceRefusal';
  }
}

/**
 * The tax rate to invoice at (default 15). Outside 0-100 it is refused: 101
 * made VAT exceed the subtotal, and a negative rate reaches migration 692.
 */
export function assertWipTaxRate(input: number | undefined): number {
  const taxRate = input ?? 15;
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    throw new WipInvoiceRefusal(`taxRate must be between 0 and 100, got ${String(input)}`);
  }
  // tax_rate is numeric(5,2): 15.555 would be stored as 15.56 beside VAT
  // computed at 15.555, so the stored rate would not explain the VAT.
  if (Math.abs(taxRate * 100 - Math.round(taxRate * 100)) > 1e-6) {
    throw new WipInvoiceRefusal(`taxRate allows at most 2 decimals, got ${String(input)}`);
  }
  return taxRate;
}

/**
 * Every entry must carry a non-negative, numeric rate and line — checked per
 * line, not on the sum: a negative entry inside a positive invoice is a credit
 * embedded in a sale. time_entries CHECKs hours > 0, but nothing constrains
 * rate or line_total.
 */
export function assertWipEntryLines(entries: DbRow[]): void {
  for (const e of entries) {
    // null → NaN, not Number(null) = 0: a missing rate is not a free line.
    const line = e.line_total == null ? Number.NaN : Number(e.line_total);
    const rate = e.applied_rate == null ? Number.NaN : Number(e.applied_rate);
    // hours > 0 is a CHECK and line must equal hours × rate (below), so a
    // negative rate is the one sign to test: it is what makes a line negative.
    if (!Number.isFinite(line) || !Number.isFinite(rate) || rate < 0) {
      throw new WipInvoiceRefusal(
        `time entry of ${fmtDate(e.entry_date)} ("${String(e.task_description)}") has a negative or `
        + `non-numeric amount (rate ${String(e.applied_rate)}, line ${String(e.line_total)}). `
        + 'Correct the entry, or bill the reduction as a credit note.',
      );
    }
    // Every writer stores line_total = round2(hours × applied_rate)
    // (lineTotalFor); a line that disagrees would bill a figure its own
    // hours and rate do not explain. 1c tolerance for the rounding.
    const hours = Number(e.hours);
    if (!(Math.abs(Math.round(hours * rate * 100) / 100 - line) <= 0.01)) {
      throw new WipInvoiceRefusal(
        `time entry of ${fmtDate(e.entry_date)} ("${String(e.task_description)}") has a line of ${String(e.line_total)} `
        + `that is not its ${String(e.hours)}h × ${String(e.applied_rate)}. Re-save the entry to recompute it.`,
      );
    }
  }
}
