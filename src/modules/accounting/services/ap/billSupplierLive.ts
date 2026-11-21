/**
 * A bill is never written onto a soft-deleted supplier (review of 0d51f4a5, L2): migration 1021's `trg_supplier_invoices_supplier_live`
 * refuses it for every writer (create, the draft edit's supplier change, imports, recurring, capture), after the FK has waited for any
 * supplier merge holding the row, with SQLSTATE 23503 and constraint `supplier_invoices_supplier_live`. The paths an agent or the app
 * reports from (createSupplierInvoice: the REST create, MCP single and bulk, the Sage commit; the MCP draft edit) answer it typed.
 */
export class BillSupplierDeletedError extends Error {
  readonly code = 'SUPPLIER_INVOICE_SUPPLIER_DELETED';
  constructor() {
    super('The supplier was merged or deleted while this bill was being saved, so nothing was saved. '
      + 'Enter the bill again for the supplier it was merged into (or another live supplier).');
    this.name = 'BillSupplierDeletedError';
  }
}

/** The typed refusal for the trigger's error, or null for anything else. */
export function asBillSupplierDeleted(err: unknown): BillSupplierDeletedError | null {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e && e.code === '23503' && e.constraint === 'supplier_invoices_supplier_live' ? new BillSupplierDeletedError() : null;
}
