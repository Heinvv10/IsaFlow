/**
 * The ONE route answer for a bill written onto a soft-deleted supplier (review of b4741393, M2): migration 1021's supplier-live
 * trigger (SQLSTATE 23503, constraint supplier_invoices_supplier_live) or its typed form, `BillSupplierDeletedError`
 * (ap/billSupplierLive.ts). 409 with the typed wording and code. `respondToUnhandledError` asks it, so a route that does not map it
 * (capture post, the AI pipeline, anything that rethrows) answers it the same. A 4xx is safe here: the failed statement either ran
 * in a savepoint that rolled back, or left the request transaction aborted, which withAuth's COMMIT then rolls back.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { BillSupplierDeletedError, asBillSupplierDeleted } from '@/modules/accounting/services/ap/billSupplierLive';

export function respondIfBillSupplierDeleted(res: NextApiResponse, err: unknown): boolean {
  const typed = err instanceof BillSupplierDeletedError ? err : asBillSupplierDeleted(err);
  if (!typed) return false;
  apiResponse.conflict(res, typed.message, { code: typed.code });
  return true;
}
