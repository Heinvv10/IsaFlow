/**
 * A bill insert or supplier change onto a soft-deleted supplier is refused (review of 0d51f4a5, L2): migration 1021's
 * `trg_supplier_invoices_supplier_live` refuses it for every writer, after the FK has waited for a supplier merge
 * holding the row (both merge paths take it FOR UPDATE, but only the duplicates merge soft-deletes its source; a plain supplier
 * soft-delete takes no such lock, see Known limits), with SQLSTATE 23503
 * and constraint `supplier_invoices_supplier_live`. createSupplierInvoice (REST, MCP single and bulk, the Sage commit) and the MCP
 * draft edit map it to this error; every other route reaches `respondIfBillSupplierDeleted` through respondToUnhandledError (409).
 */
import { sql } from '@/lib/neon';
import { SoftDeleteRefusalError } from '../core/softDeleteErrors';

export class BillSupplierDeletedError extends Error {
  readonly code = 'SUPPLIER_INVOICE_SUPPLIER_DELETED';
  constructor() {
    super('The supplier has been merged into another or deleted, so this bill was not saved. '
      + 'Enter it again for the supplier it was merged into, or another live supplier.');
    this.name = 'BillSupplierDeletedError';
  }
}

/** The typed refusal for the trigger's error, or null for anything else. */
export function asBillSupplierDeleted(err: unknown): BillSupplierDeletedError | null {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e && e.code === '23503' && e.constraint === 'supplier_invoices_supplier_live' ? new BillSupplierDeletedError() : null;
}

/**
 * The undo of a deleted bill does not fire the trigger (supplier_id is unchanged), so it checks itself (review of b4741393, L2): a
 * bill whose supplier has since been soft-deleted stays deleted (`SoftDeleteRefusalError`, 400), with the exit. Only a plain
 * supplier soft-delete leaves one here: a merge moves deleted bills to its target too (review of 95ef48f8, L1), so the exit is to
 * restore the supplier first. Called after the restore's own bill row lock (assertBillRestorableGrn), so it reads the bill's supplier
 * as it stands.
 */
export async function assertBillRestorableSupplier(companyId: string, billId: string): Promise<void> {
  const gone = (await sql`
    SELECT 1 FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id
     WHERE si.id = ${billId}::uuid AND si.company_id = ${companyId}::uuid AND s.deleted_at IS NOT NULL
  `) as unknown[];
  if (gone.length > 0) {
    throw new SoftDeleteRefusalError('This bill\'s supplier has been deleted, so the bill cannot be restored: '
      + 'restore the supplier first (undo its delete), then the bill');
  }
}
