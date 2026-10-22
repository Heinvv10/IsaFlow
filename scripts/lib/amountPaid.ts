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

export function deriveAmountPaid(total: number, amountDue: number): DerivedAmountPaid {
  const raw = cents(total - amountDue);
  const ceiling = Math.max(total, 0);
  const clamped = raw > ceiling;
  return {
    amountPaid: clamped ? ceiling : raw,
    clamped,
    // an over-payment is fully settled; otherwise keep the source rule (nothing due)
    paid: clamped || amountDue === 0,
  };
}
