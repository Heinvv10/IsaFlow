/**
 * A document's total may not be negative. A reduction is a credit note.
 *
 * R-119. `customer_invoices` and `supplier_invoices` had nothing restricting
 * the sign of `total_amount` — no CHECK, no trigger — and a census of all 17
 * INSERT sites found four writers with no guard of their own: recurring
 * templates at EXECUTION time (their create-time `quantity > 0 / unitPrice
 * >= 0` check does not re-run, does not cover AP templates, and does not
 * cover a line-less template's stored `totalAmount`), the AI capture pipeline
 * (whose validator tested null/undefined only), time-entry billing (where
 * neither the invoice build nor `createTimeEntry` guards hours or rate), and
 * the Sage AR import (`=== 0`, where its AP sibling guards `> 0`).
 *
 * WHY IT MATTERS, not merely tidiness: a negative-total invoice is an ad-hoc
 * credit note living outside `credit_notes`. The ageing and the subledger
 * filter `balance > 0`, so they never show it, while its journal — once
 * posted — sits in the GL: an AR/AP-vs-GL difference no report can explain.
 * `credit_notes` already serves both sides (`type` is 'customer' or
 * 'supplier'), with its own numbering, approval and application.
 *
 * Migration 692 puts the same rule in the database, which is what actually
 * closes the class — it catches the writer nobody enumerated, the scripts and
 * the next agent. This helper exists so the four known paths refuse with a
 * message naming the remedy, instead of surfacing a raw trigger error.
 */

/** Thrown when a writer is handed a negative — or non-finite — document total. */
export class NegativeDocumentTotalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NegativeDocumentTotalError';
  }
}

/**
 * Refuse a negative total.
 *
 * `label` names the document for the operator ("Recurring template A-1",
 * "Sage invoice INV-9"); `side` picks the remedy's wording. Zero is allowed:
 * a zero-total document is odd but coherent, and the paths that refuse one do
 * so for their own reasons.
 */
export function assertNonNegativeDocumentTotal(
  totalAmount: number,
  label: string,
  side: 'customer' | 'supplier',
): void {
  // `Number.isFinite`, not `!(total < 0)`: NaN fails every comparison, so a
  // sign test lets it through — and NaN is worse than a negative. It passes
  // the `balance > 0` filter the ageing uses (NaN > 0 is TRUE in PostgreSQL)
  // and poisons every SUM over the column. `Number(...)` on a non-numeric
  // field — opaque templateData, an extractor's output — is where it comes
  // from. Infinity is refused for the same reason.
  if (Number.isFinite(totalAmount) && totalAmount >= 0) return;
  const document = side === 'customer' ? 'customer invoice' : 'supplier invoice';
  if (!Number.isFinite(totalAmount)) {
    throw new NegativeDocumentTotalError(
      `${label} has a total that is not a number (${String(totalAmount)}), which a ${document} `
      + 'may not carry. Check the source figure.',
    );
  }
  throw new NegativeDocumentTotalError(
    `${label} has a negative total (${totalAmount.toFixed(2)}), which a ${document} may not carry. `
    + 'A reduction is a credit note: raise one against the original document.',
  );
}
