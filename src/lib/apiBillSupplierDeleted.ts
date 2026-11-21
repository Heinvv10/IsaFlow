/**
 * The ONE route answer for a bill written onto a soft-deleted supplier (review of b4741393, M2): migration 1021's supplier-live
 * trigger (SQLSTATE 23503, constraint supplier_invoices_supplier_live) or its typed form, `BillSupplierDeletedError`
 * (ap/billSupplierLive.ts). 409 with the typed wording and code. `respondToUnhandledError` asks it, so a route that does not map it
 * (capture post, the AI pipeline, anything that rethrows) answers it the same. So is 1021's grn-live trigger (SQLSTATE 23503,
 * constraint supplier_invoices_grn_live: a live bill on a cancelled, foreign or missing goods received note; Codex gate at 42de08b3,
 * 4), as `SupplierInvoiceGrnRefusal`'s wording and code; createSupplierInvoice, the draft edit and the restore map it themselves (the
 * first two in their savepoint), and no other writer sets grn_id.
 *
 * A 4xx is safe ONLY where the refused INSERT / UPDATE ran in its own savepoint, or aborted the request transaction before anything
 * else that request wrote could be committed: withAuth COMMITs below 500, and COMMIT of an aborted transaction is a rollback. Today:
 *   - createSupplierInvoice (REST create, MCP single and bulk, Sage commit) and the MCP draft edit: the write runs in a withTransaction
 *     savepoint, which rolls back; they answer their own typed refusal before reaching here;
 *   - capture/[id]/post and ai-invoice-pipeline: the bill INSERT is a plain statement in the request transaction; the trigger's error
 *     aborts it, so the event / document locks and the claim they took before it are not committed (their candidate lists exclude
 *     deleted suppliers, so this is the race only);
 *   - recurring, the Sage import service, the migration AP import: they refuse a deleted supplier before their INSERT (or match live
 *     suppliers only) and run each row in a savepoint.
 * A new caller that catches the error and goes on writing in the same transaction would commit those writes with this 409.
 * Migration 1022's payment twin (constraint supplier_payments_supplier_live, `PaymentSupplierDeletedError`) is answered the same:
 * the payment writers lock the payee live first (core/supplierLiveLock), so it is reached only by a writer that skips that.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import {
  BillSupplierDeletedError, PaymentSupplierDeletedError, asBillSupplierDeleted, asPaymentSupplierDeleted,
} from '@/modules/accounting/services/ap/billSupplierLive';
import { asBillGrnRefused } from '@/modules/accounting/services/ap/billGoodsReceivedLink';

export function respondIfBillSupplierDeleted(res: NextApiResponse, err: unknown): boolean {
  const typed = err instanceof BillSupplierDeletedError || err instanceof PaymentSupplierDeletedError ? err
    : asBillSupplierDeleted(err) ?? asPaymentSupplierDeleted(err) ?? asBillGrnRefused(err);
  if (!typed) return false;
  apiResponse.conflict(res, typed.message, { code: typed.code });
  return true;
}
