/**
 * What a live credit note actually took off the balance it applies to —
 * shared by the customer statement (`ar/statementEmailService`) and the
 * supplier statement (`ap/supplierStatementService`), which had identical
 * copies of this function (R-082 round 3: extracted to stop the drift, and
 * because `statementEmailService.ts` was over the 300-line cap).
 *
 * Approving a note applies MIN(total_amount, outstanding) and records that
 * capped figure in `applied_amount`; the status only becomes 'applied' when
 * that figure is above zero. So:
 *   - 'applied'  → applied_amount is what was consumed, and total_amount may be
 *     larger. The remainder is stranded: a note at 'applied' cannot be applied
 *     again, so crediting the face value shows more credit than was actually
 *     received — on a document we email the customer, or use to work out
 *     what we still owe a supplier.
 *   - 'approved' → applied_amount is 0 by construction, and the note is
 *     unallocated credit held at face value.
 *   - 'partially_applied' (migration 677) → part of the note settled documents
 *     and the REST is still available, so the statement credits the FACE value:
 *     the applied part is already off the documents' balances, and the
 *     remainder is credit the counterparty still holds. That is the default
 *     branch below, which is why this function did not change — but it is the
 *     status that makes the rule worth stating.
 * Same rule the aging already follows (agingRewind, apAgingService).
 */
export function creditNoteAppliedAmount(cn: {
  status?: unknown;
  total_amount?: unknown;
  applied_amount?: unknown;
}): number {
  return String(cn.status ?? '') === 'applied'
    ? Number(cn.applied_amount ?? 0)
    : Number(cn.total_amount ?? 0);
}
