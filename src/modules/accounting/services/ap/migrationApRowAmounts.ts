/**
 * The per-row amount checks of the AP take-on importer, moved out of
 * `migrationApService` (300-line cap) without change except the over-payment
 * refusal at the end.
 *
 * At most one of `error` / `warning` is set. An error means the row is skipped.
 */

import type { MigrationError } from '../core/migrationService';
import { toCents } from './billAllocatable';

export interface TakeOnAmountVerdict {
  error: MigrationError | null;
  warning: MigrationError | null;
}

interface TakeOnAmounts {
  invoiceNumber: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid?: number;
}

export function checkTakeOnAmounts(inv: TakeOnAmounts, row: number): TakeOnAmountVerdict {
  const refuse = (field: string, message: string): TakeOnAmountVerdict => ({
    error: { step: 'ap_invoices', row, field, message }, warning: null,
  });

  // R-002. A take-on entry carries ONE figure — the outstanding amount — so
  // subtotal and tax never have to balance against anything, and cents of
  // drift in a source export cost nothing. Refusing at a cent lost real
  // invoices over the exporter's own rounding. Import up to 5c with a
  // warning; refuse beyond that, where the file is wrong rather than rounded.
  // R-119: a take-on file that carries its credit notes as NEGATIVE open
  // items. Migration 692 refuses the row at the database, so without this
  // the operator would get a raw trigger message against a file row. There
  // is no credit-note step in this importer, so the honest answer is to
  // name the row and say where it belongs — the opening balance is short
  // by it until those are loaded as credit notes.
  // The LEGS as well as the total: the drift check below is
  // |subtotal + tax - total|, which a SWAPPED leg satisfies exactly —
  // `subtotal 1200, tax -200, total 1000` passes both it and a total-only
  // guard, then hits migration 692's leg arm with a raw message instead of
  // this one.
  if (!Number.isFinite(inv.totalAmount) || inv.totalAmount < 0
      || !Number.isFinite(inv.subtotal) || inv.subtotal < 0
      || !Number.isFinite(inv.taxAmount) || inv.taxAmount < 0) {
    return refuse('totalAmount', `${inv.invoiceNumber} has an amount a take-on bill may not carry `
      + `(total ${String(inv.totalAmount)}, subtotal ${String(inv.subtotal)}, tax ${String(inv.taxAmount)}). `
      + 'Load a credit as a credit note against the document it reduces.');
  }

  let warning: MigrationError | null = null;
  const amountsDrift = Math.abs(inv.subtotal + inv.taxAmount - inv.totalAmount);
  if (amountsDrift > 0.005) {
    const detail = `subtotal ${inv.subtotal.toFixed(2)} + tax ${inv.taxAmount.toFixed(2)} != total ${inv.totalAmount.toFixed(2)}`;
    if (amountsDrift > 0.05) return refuse('totalAmount', `Amounts do not add up for ${inv.invoiceNumber}: ${detail}`);
    warning = {
      step: 'ap_invoices', row, field: 'totalAmount',
      message: `Imported with a rounding difference: ${inv.invoiceNumber} — ${detail}`,
    };
  }

  // A bill stored paid beyond its total carries a negative `balance` that every AP aggregate sums, and nothing
  // downstream clamps it. The AR importer refuses the same row (migration 899 backs that with a CHECK); this is
  // the AP twin, in whole cents with no tolerance like every supplier-side over-payment guard
  // (`billAllocatable.toCents`). The excess is a credit the supplier owes the company, not part of this bill.
  const paid = inv.amountPaid ?? 0;
  if (toCents(paid) > toCents(inv.totalAmount)) {
    return refuse('amountPaid', `${inv.invoiceNumber} is paid ${paid.toFixed(2)}, which exceeds its total of `
      + `${inv.totalAmount.toFixed(2)}. Import it at its total and load the excess as a supplier credit note or refund.`);
  }
  return { error: null, warning };
}
