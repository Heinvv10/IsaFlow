/**
 * The evidence attach the capture posting routes run after creating a supplier
 * invoice — and, when that invoice was AUTO-APPROVED, the settlement R-127
 * requires of every approval.
 *
 * `capture/[id]/post` and `ai-invoice-pipeline` INSERT an auto-approved invoice
 * as 'approved' with no journal and never call `approveSupplierInvoice`. When
 * the attach below then makes a bank-first provisional the slip's evidence, the
 * ledger already holds the bill (expense / VAT / bank) while the AP subledger
 * shows it owing, and "Post to GL" would book it a second time. So the invoice
 * is posted here through `postSupplierInvoiceToGL`, which — like approval —
 * reclasses the provisional into the invoice's payment
 * (`ap/provisionalInvoiceSettlement.ts`) and leaves it paid.
 *
 * Best-effort, like the attach itself, and in its OWN savepoint: a failure (an
 * invoice with no line items cannot post a balanced journal) rolls back only
 * the settlement, leaving the invoice approved and unposted exactly as before,
 * and never the request that created it.
 */
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { attachEvidenceToProvisional, type AttachResult } from './evidenceAttachmentService';

export interface AttachAndSettleInput {
  companyId: string;
  userId: string;
  documentId: string;
  invoiceId: string;
  /** The status the route inserted the invoice with. */
  invoiceStatus: string;
  supplierId: string;
  totalAmount: number;
  invoiceDate: string;
}

export async function attachEvidenceAndSettleApproved(input: AttachAndSettleInput): Promise<AttachResult> {
  const { companyId, documentId, invoiceId } = input;
  const attached = await attachEvidenceToProvisional(
    companyId, documentId, input.supplierId, input.totalAmount, input.invoiceDate,
  );
  if (!attached.attachedJeId || input.invoiceStatus !== 'approved') return attached;

  try {
    await withSavepoint('provisional_settle', () => postSupplierInvoiceToGL(companyId, invoiceId, input.userId));
  } catch (err) {
    log.warn('Auto-approved invoice could not be settled against its provisional — left approved and unposted', {
      companyId, invoiceId, provisionalJeId: attached.attachedJeId,
      error: err instanceof Error ? err.message : String(err),
    }, 'evidence-attachment');
  }
  return attached;
}
