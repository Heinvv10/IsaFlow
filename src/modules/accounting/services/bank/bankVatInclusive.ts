/**
 * The VAT inside a VAT-inclusive bank amount, as a bank allocation books it.
 * Moved verbatim out of bankAllocationService.ts (R-035 PR6 round 4: that
 * file is at its line cap, and the manual-journal gate needed the room).
 */

/** Standard SA VAT rate; update if SARS changes the statutory rate. */
export const SA_VAT_RATE_PCT = 15;

/** `amount` split into net and VAT at the standard rate when `hasVat`, else all net; each rounded to cents. */
export function vatInclusiveSplit(amount: number, hasVat: boolean): { vatRate: number; netAmount: number; vatAmount: number } {
  const netAmount = hasVat ? Math.round((amount * 100 / (100 + SA_VAT_RATE_PCT)) * 100) / 100 : amount;
  const vatAmount = hasVat ? Math.round((amount - netAmount) * 100) / 100 : 0;
  return { vatRate: hasVat ? SA_VAT_RATE_PCT : 0, netAmount, vatAmount };
}
