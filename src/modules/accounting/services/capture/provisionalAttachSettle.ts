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
 * In its OWN savepoint: a failure (an invoice with no line items cannot post a
 * balanced journal; a refusal such as a filed VAT period) rolls back only the
 * settlement, never the request that created the invoice. The auto-approval is
 * then WITHDRAWN — the bill goes back to 'draft' with the reason in its notes and
 * in the response. Left 'approved' with no journal it read as owing in the AP
 * ageing a bill the provisional has already paid, and paying it would pay twice;
 * a draft is outside the AP population until a person approves it.
 *
 * `postUnattached` (capture/[id]/post, R-131; ai-invoice-pipeline, R-160): an
 * auto-approved invoice that evidences NO provisional is posted the same way —
 * without it that bill sat
 * 'approved' with no journal, owing in the AP subledger and absent from the GL —
 * and is withdrawn to draft the same way when its journal cannot post.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isHeldRowError } from '@/lib/lockTimeout';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { attachEvidenceToProvisional, type AttachResult } from './evidenceAttachmentService';
import { replanCaptureSlipDimensions, type CaptureSlipPlan } from './captureSlipReplan';
import { recordBudgetRefusal } from '../budgets/budgetCheck';
import { BudgetExceededError } from '../budgets/budgetCheckTypes';

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
  /** Also post an auto-approved invoice that evidences no provisional (R-131, R-160). */
  postUnattached?: boolean;
  /** What the capture line plan inherited from a provisional (`insertCaptureBillLines`); re-planned after the attach. */
  slip?: CaptureSlipPlan;
}

export async function attachEvidenceAndSettleApproved(
  input: AttachAndSettleInput,
): Promise<AttachResult & { settlementRefused?: string }> {
  const { companyId, documentId, invoiceId } = input;
  const attached = await attachEvidenceToProvisional(
    companyId, documentId, input.supplierId, input.totalAmount, input.invoiceDate,
  );
  // P5-2b, fail closed: inherited dimensions only ever come from the provisional actually attached (or none).
  await replanCaptureSlipDimensions(companyId, invoiceId, input.supplierId, input.slip, attached.attachedJeId);
  if (input.invoiceStatus !== 'approved' || (!attached.attachedJeId && !input.postUnattached)) return attached;

  try {
    // Budgets P5-2 (census finding 1): this is the auto-approval the budget check must see. The routes
    // already hold the captured document, its events, the posted-content key and the new bill, so the
    // company budget lock cannot come first: lock-free (`none`), refusing an over-budget bill in block
    // mode. Named residual race (ap/.claude.md): two such postings racing in block mode can both pass.
    await withSavepoint('provisional_settle', () => postSupplierInvoiceToGL(companyId, invoiceId, input.userId, {
      budget: { channel: 'system', lock: 'none' },
    }));
  } catch (err) {
    // Contention, not a refusal (D8 round 11): the savepoint rolled the settlement back, and a retry of the whole
    // request settles it — withdrawing the auto-approval would send a person to approve by hand for a 5 s wait.
    // D11: ALL contention — a typed timeout, a held refusal, a raw 55P03 or a 40P01 deadlock victim — not only the typed.
    if (isHeldRowError(err)) throw err;
    // Over budget under block: the savepoint rolled the posting back; the refusal is recorded here, on the
    // request transaction, and the auto-approval is withdrawn below like any other refusal.
    if (err instanceof BudgetExceededError) await recordBudgetRefusal(err);
    const reason = err instanceof Error ? err.message : String(err);
    const why = attached.attachedJeId
      ? `this bill's slip is already booked by a bank-first provisional journal, and settling the bill against it failed (${reason})`
      : `its journal could not be posted (${reason})`;
    log.warn('Auto-approved invoice could not be posted or settled — returned to draft', {
      companyId, invoiceId, provisionalJeId: attached.attachedJeId, error: reason,
    }, 'evidence-attachment');
    // Outside the savepoint, on the request transaction: no journal was left, so
    // only the status moves back. Not caught — a failure here must fail the request.
    await sql`
      UPDATE supplier_invoices
      SET status = 'draft', approved_by = NULL, approved_at = NULL,
          notes = concat_ws(E'\n', notes, ${`Auto-approval withdrawn: ${why}. Review it and approve it by hand.`}::TEXT)
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        AND status = 'approved' AND gl_journal_entry_id IS NULL
    `;
    return { ...attached, settlementRefused: reason };
  }
  return attached;
}
