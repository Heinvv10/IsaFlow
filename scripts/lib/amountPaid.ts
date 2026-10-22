/**
 * Derive customer_invoices.amount_paid from a source total and outstanding amount,
 * so the row satisfies CHECK customer_invoices_amount_paid_within_total
 * (migrations 899/900): amount_paid <= GREATEST(total_amount, 0).
 * The CHECK has no lower bound (credit-note application may leave amount_paid negative),
 * so only the upper bound is clamped.
 */
export interface DerivedAmountPaid {
  amountPaid: number;
  /** True when the source value exceeded the CHECK ceiling and was reduced. */
  clamped: boolean;
  /** True when the invoice should be stored as 'paid'. */
  paid: boolean;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * `amountDue` may be missing in the source; a missing value is treated as 0 for the
 * arithmetic but is NOT evidence of payment, so it never yields `paid`.
 * Throws on non-finite input rather than passing NaN into the insert.
 */
export function deriveAmountPaid(total: number, amountDue: number | null | undefined): DerivedAmountPaid {
  const due = amountDue ?? 0;
  if (!Number.isFinite(total) || !Number.isFinite(due)) {
    throw new Error(`deriveAmountPaid: non-finite input (total=${total}, amountDue=${amountDue})`);
  }
  const raw = cents(total - due);
  const ceiling = cents(Math.max(total, 0));
  const clamped = raw > ceiling;
  return {
    amountPaid: clamped ? ceiling : raw,
    clamped,
    // an over-payment is fully settled; otherwise keep the source rule (explicit zero due)
    paid: clamped || amountDue === 0,
  };
}
