/**
 * A bank line whose SIGN contradicts the subledger document it was told to
 * settle.
 *
 * `allocate_bank_transaction` with an `invoice_id` routes to
 * `confirmReceiptMatch` / `applyBankLineToSupplierInvoices`, and both take the
 * ABSOLUTE value of the bank line and apply it as a settlement. So a supplier
 * REFUND (money in) named against a bill would settle that bill by the refund's
 * value — cash coming back in recorded as the bill being paid — and a customer
 * refund (money out) would settle an invoice the same way.
 *
 * The GL half of this is fixable and is fixed: `allocateTransaction` now posts a
 * refund in the direction the sign says. The APPLY half is not a direction
 * problem, it is a missing concept — there is no "refund allocation" against an
 * invoice, and inventing one silently is exactly the class of guess that put
 * R261,651.64 into the wrong side of Velocity Fibre's ledger. So the line is
 * refused, and the refusal says what to do instead: drop `invoice_id` and let
 * it post as a refund journal.
 *
 * Thrown, not returned. The registry's savepoint unwinds on a throw only; a
 * `catch → toolError` releases it and the transport's 200 commits whatever was
 * already written. Nothing HAS been written when this is raised — it is checked
 * before the first write — but the shape has to hold for the paths where that
 * is not obvious.
 *
 * Lives beside `bulkAllocationLineError` at the top of `src/lib/mcp` for the
 * same reason: `registry.ts` renders it, and the registry must not depend on a
 * tool module.
 */
export class BankLineDirectionError extends Error {
  readonly transactionId: string;

  constructor(transactionId: string, reason: string) {
    super(reason);
    this.name = 'BankLineDirectionError';
    this.transactionId = transactionId;
  }
}

/** The text a tool result carries for `err`. Never SQL, never a stack. */
export function bankLineDirectionErrorText(
  toolName: string,
  err: BankLineDirectionError,
): string {
  return `${toolName} (${err.transactionId}): ${err.message} — nothing posted`;
}
