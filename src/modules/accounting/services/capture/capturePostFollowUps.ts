/**
 * What the capture inbox's POST route does once the supplier invoice exists:
 * link the document and mark the event posted, record the coding for the
 * learning loop, then the three best-effort follow-ups — attach the evidence to
 * a provisional journal, resolve a pending alert, run the 3-way match — none of
 * which may fail the post.
 *
 * Split out of `pages/api/accounting/capture/[id]/post.ts` (K-072 round 18),
 * which had grown past the 300-line cap. The statements, their order and their
 * error handling are the route's, unchanged; only `recordCoding` is awaited
 * without a catch, exactly as it was.
 */
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { recordCoding, type SupplierRule } from './supplierRulesService';
import { attachEvidenceToProvisional } from './evidenceAttachmentService';
import { resolvePendingAlertForInvoice } from './alertResolutionService';
import { performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

export type PublishedDecision =
  | { outcome: 'auto_publish'; reason: string; rule: SupplierRule }
  | { outcome: 'route_review'; reasons: string[]; rule: SupplierRule | null };

export interface CapturePostFollowUpInput {
  companyId: string;
  userId: string;
  eventId: string;
  documentId: string;
  invoiceId: string;
  supplierId: string;
  supplierName: string;
  vendorVatNumber: string | null | undefined;
  totalAmount: number;
  invoiceDate: string;
  decision: PublishedDecision;
}

export interface CapturePostFollowUps {
  provisionalAttach: { attachedJeId: string | null; bankTxId: string | null };
  threeWayMatch: Awaited<ReturnType<typeof performThreeWayMatch>> | null;
}

export async function runCapturePostFollowUps(input: CapturePostFollowUpInput): Promise<CapturePostFollowUps> {
  const { companyId, userId, eventId, documentId, invoiceId, supplierId } = input;

  // Link document and mark event posted. `status` is not stamped here any more
  // — the route's posting claim already settled it, and writing it twice was what made
  // the lifecycle column look like the fence.
  await sql`
    UPDATE captured_documents
    SET matched_invoice_id = ${invoiceId}::uuid
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
  `;

  await sql`
    UPDATE capture_events
    SET status = 'posted', posted_by = ${userId}, posted_at = NOW(), updated_at = NOW()
    WHERE id = ${eventId}::uuid AND company_id = ${companyId}
  `;

  const codingRule = input.decision.rule;
  await recordCoding(companyId, {
    supplierId,
    supplierInvoiceId: invoiceId,
    glAccountId: codingRule?.defaultGlAccountId ?? null,
    vatCode: codingRule?.defaultVatCode ?? input.vendorVatNumber ?? null,
    costCentreId: codingRule?.defaultCostCentreId ?? null,
    projectId: codingRule?.defaultProjectId ?? null,
    postedBy: `human:${userId}`,
  });

  log.info('Capture event posted', {
    eventId, documentId, invoiceId,
    supplier: input.supplierName,
    gateOutcome: input.decision.outcome,
  }, 'capture-post');

  // Attempt to attach evidence to a matching provisional JE (best-effort, non-blocking)
  let provisionalAttach: CapturePostFollowUps['provisionalAttach'] = { attachedJeId: null, bankTxId: null };
  try {
    provisionalAttach = await attachEvidenceToProvisional(
      companyId,
      documentId,
      supplierId,
      input.totalAmount,
      input.invoiceDate,
    );
  } catch (attachErr) {
    log.warn('Evidence attach to provisional JE failed — continuing', { eventId, error: attachErr }, 'capture-post');
  }

  // Best-effort alert resolution — non-blocking
  resolvePendingAlertForInvoice(
    companyId,
    supplierId,
    invoiceId,
    input.invoiceDate,
  ).catch((err: unknown) => {
    log.warn('resolvePendingAlertForInvoice failed (non-blocking)', { invoiceId, error: err }, 'capture-post');
  });

  // Run 3-way match if the invoice has a linked PO; non-blocking on error
  let threeWayMatch: CapturePostFollowUps['threeWayMatch'] = null;
  try {
    threeWayMatch = await performThreeWayMatch(companyId, invoiceId);
  } catch (matchErr) {
    log.error('3-way match failed post-capture-post — continuing', { invoiceId, error: matchErr }, 'capture-post');
  }

  return { provisionalAttach, threeWayMatch };
}
