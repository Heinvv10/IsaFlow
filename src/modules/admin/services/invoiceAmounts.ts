/**
 * Platform invoice amounts from the subtotal alone: 15% VAT, rounded half up to the cent, and
 * total = subtotal + VAT. The create route stores exactly this (a client-sent tax or total is refused);
 * the admin page uses the same function for its preview, so the two cannot disagree.
 */
import { SA_STANDARD_VAT_RATE_PCT } from '@/lib/vat/standardRate';

/** The largest subtotal a platform invoice may carry: its total (x1.15) must still fit the INT columns. */
export const MAX_INVOICE_SUBTOTAL_CENTS = 1_800_000_000;

export interface InvoiceAmounts {
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
}

/** `subtotalCents` must be a non-negative whole number of cents (the route's zod schema enforces it). */
export function invoiceAmountsFromSubtotal(subtotalCents: number): InvoiceAmounts {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) {
    throw new RangeError(`subtotal must be a non-negative whole number of cents, got ${subtotalCents}`);
  }
  // Math.round on a non-negative value is half up: 1.5c -> 2c.
  const tax_cents = Math.round((subtotalCents * SA_STANDARD_VAT_RATE_PCT) / 100);
  return { subtotal_cents: subtotalCents, tax_cents, total_cents: subtotalCents + tax_cents };
}
