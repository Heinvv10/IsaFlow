/**
 * POST /api/accounting/capture/[id]/post
 * Runs the AI invoice pipeline for the capture event, then marks it posted.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { ErrorCode } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  validatePipelineInput,
  matchSupplierFromExtraction,
  buildInvoiceFromExtraction,
  determineApprovalRoute,
  computePipelineConfidence,
  type PipelineThresholds,
} from '@/modules/accounting/services/core/aiInvoicePipelineService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { decide } from '@/modules/accounting/services/capture/autoPublishGateService';
import {
  lockCaptureEventForPosting,
  CaptureEventLockedError,
  isCaptureEventPostable,
} from '@/modules/accounting/services/capture/captureEventLock';
import { computeFingerprint } from '@/modules/accounting/services/capture/captureDeduplicationService';
import { recordCoding } from '@/modules/accounting/services/capture/supplierRulesService';
import { performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { resolvePendingAlertForInvoice } from '@/modules/accounting/services/capture/alertResolutionService';

type Row = Record<string, unknown>;

const DEFAULT_THRESHOLDS: PipelineThresholds = {
  autoApproveConfidence: 0.95,
  routeApprovalConfidence: 0.85,
  highValueAmount: 100000,
  lowValueAutoApproveAmount: 5000,
};

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const userId = req.user?.id ?? '';
  const eventId = req.query.id as string;

  if (!eventId) return apiResponse.badRequest(res, 'eventId is required');

  // Load event + document under a row lock on the event.
  //
  // The lock is what makes the 'already posted' refusal below meaningful. A
  // plain SELECT let two concurrent requests both read a non-posted status,
  // both pass the check, and both INSERT a supplier_invoice — one captured bill
  // accrued twice against the payable control account. The closing UPDATE
  // carries no status predicate, so nothing downstream caught it either.
  let event: Row | null;
  try {
    event = (await lockCaptureEventForPosting(companyId, eventId)) as Row | null;
  } catch (lockErr) {
    if (lockErr instanceof CaptureEventLockedError) {
      return apiResponse.conflict(res, lockErr.message);
    }
    throw lockErr;
  }

  if (!event) {
    return apiResponse.notFound(res, 'Capture event', eventId);
  }

  // Postable is an ALLOW-list (`captureEventLock.ts`), not `status === 'posted'`.
  // Naming one value left every OTHER terminal state postable: a user could
  // discard a captured document and then post it anyway, with no race at all.
  if (!isCaptureEventPostable(event.event_status)) {
    return apiResponse.badRequest(
      res,
      event.event_status === 'posted'
        ? 'Event already posted'
        : `Event cannot be posted from status '${String(event.event_status)}'`,
    );
  }

  if (!event.extracted_data) {
    return apiResponse.badRequest(res, 'Document has no extracted data — extraction may still be in progress');
  }

  const documentId = event.captured_document_id as string;
  const extracted = event.extracted_data as ExtractedDocument;

  // Validate
  const validation = validatePipelineInput(extracted);
  if (!validation.valid) {
    return apiResponse.badRequest(res, `Validation failed: ${validation.errors.join(', ')}`);
  }

  // Match supplier
  const suppliers = await sql`
    SELECT id, name, vat_number FROM suppliers WHERE company_id = ${companyId} AND is_active = true
  ` as Row[];

  const supplierMatch = matchSupplierFromExtraction(
    extracted,
    suppliers.map((s) => ({ id: s.id as string, name: s.name as string })),
  );

  if (!supplierMatch) {
    return apiResponse.success(res, {
      status: 'manual_review',
      reason: `No matching supplier found for "${extracted.vendorName}"`,
      extractedVendor: extracted.vendorName,
      confidence: 0,
    });
  }

  const invoiceInput = buildInvoiceFromExtraction(extracted, supplierMatch.supplierId);
  const pipelineConfidence = computePipelineConfidence(extracted, supplierMatch);

  // The VAT segment comes from the SUPPLIER RECORD, never from the OCR'd
  // `extracted.vendorVatNumber`. Every other producer of duplicate_fingerprint
  // — ai-invoice-pipeline, supplierInvoiceService, migrationApService,
  // recurringTransactionService, sageSupplierInvoiceImportService, and
  // migrations 412 and 670 — reads `suppliers.vat_number`. Calling the same
  // helper with a different argument produces a different string, so this route
  // stored fingerprints the lookup could not match and 670 would rewrite away
  // from what the next capture of the same bill computes: the exact-match step
  // missed and the bill was accrued twice. The supplier row is also the
  // stronger identity — it is what the invoice is booked against, whereas the
  // document's VAT number is a per-scan extraction that varies with OCR quality
  // and is absent on documents that do not print one.
  const supplierVatNumber =
    (suppliers.find((s) => s.id === supplierMatch.supplierId)?.vat_number as string | null | undefined) ?? null;

  // Auto-publish gate: duplicate check + rule evaluation
  const gateDecision = await decide({
    companyId,
    supplierId: supplierMatch.supplierId,
    invoiceNumber: invoiceInput.invoiceNumber ?? null,
    totalAmount: invoiceInput.totalAmount,
    invoiceDate: invoiceInput.invoiceDate,
    vatNumber: supplierVatNumber,
    extractionConfidence: pipelineConfidence,
  });

  if (gateDecision.outcome === 'duplicate_blocked') {
    await sql`
      UPDATE capture_events
      SET status = 'failed', error = 'duplicate', updated_at = NOW()
      WHERE id = ${eventId}::uuid AND company_id = ${companyId}
    `;
    log.info('Capture blocked: duplicate invoice', { eventId, hit: gateDecision.hit }, 'capture-post');
    return apiResponse.error(res, ErrorCode.CONFLICT, 'Duplicate invoice detected', { hit: gateDecision.hit });
  }

  const approvalRoute = determineApprovalRoute(pipelineConfidence, invoiceInput.totalAmount, DEFAULT_THRESHOLDS);

  // Override status to 'approved' when gate permits auto_publish
  const invoiceStatus = gateDecision.outcome === 'auto_publish' ? 'approved' : (approvalRoute === 'auto_approve' ? 'approved' : 'draft');

  // ONE producer of duplicate_fingerprint, never an inline expression. This
  // route used to build the string in the INSERT itself, and the total was a JS
  // number bound as a parameter and cast to text there: it rendered `115`, not
  // the NUMERIC(15,2) column's `115.00`, so every
  // bill captured through this route stored a fingerprint that findDuplicate's
  // exact-match step (which calls computeFingerprint) could never match, and
  // the same bill posted a second accrual journal against the payable control
  // account. Migration 670 canonicalises the stored column once; this keeps it
  // canonical from here on.
  const captureFingerprint = computeFingerprint(
    supplierVatNumber,
    invoiceInput.invoiceNumber ?? null,
    invoiceInput.totalAmount,
  );

  // Create supplier invoice
  const [invoice] = await sql`
    INSERT INTO supplier_invoices (
      company_id, invoice_number, supplier_id, invoice_date, due_date,
      subtotal, tax_rate, tax_amount, total_amount, payment_terms,
      reference, status, created_by,
      duplicate_fingerprint, source_document_id
    ) VALUES (
      ${companyId}, ${invoiceInput.invoiceNumber}, ${supplierMatch.supplierId}::uuid,
      ${invoiceInput.invoiceDate}::date, ${invoiceInput.dueDate ?? null}::date,
      ${invoiceInput.totalAmount - invoiceInput.taxAmount}, ${invoiceInput.taxRate},
      ${invoiceInput.taxAmount}, ${invoiceInput.totalAmount},
      ${invoiceInput.paymentTerms ?? 'net30'}, ${invoiceInput.reference ?? null},
      ${invoiceStatus}, ${userId},
      ${captureFingerprint},
      ${documentId}::uuid
    )
    RETURNING id, invoice_number, status
  ` as Row[];

  if (!invoice) return apiResponse.internalError(res, null, 'Failed to create invoice');

  // Link document and mark event posted
  await sql`
    UPDATE captured_documents
    SET matched_invoice_id = ${invoice.id as string}::uuid, status = 'matched'
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
  `;

  await sql`
    UPDATE capture_events
    SET status = 'posted', posted_by = ${userId}, posted_at = NOW(), updated_at = NOW()
    WHERE id = ${eventId}::uuid AND company_id = ${companyId}
  `;

  // Record coding for the learning loop (both auto_publish and route_review paths).
  // At this point gateDecision is guaranteed to be auto_publish | route_review
  // (duplicate_blocked returned early above).
  const publishedDecision = gateDecision as
    | { outcome: 'auto_publish'; reason: string; rule: import('@/modules/accounting/services/capture/supplierRulesService').SupplierRule }
    | { outcome: 'route_review'; reasons: string[]; rule: import('@/modules/accounting/services/capture/supplierRulesService').SupplierRule | null };
  const codingRule = publishedDecision.rule;
  await recordCoding(companyId, {
    supplierId: supplierMatch.supplierId,
    supplierInvoiceId: invoice.id as string,
    glAccountId: codingRule?.defaultGlAccountId ?? null,
    vatCode: codingRule?.defaultVatCode ?? extracted.vendorVatNumber ?? null,
    costCentreId: codingRule?.defaultCostCentreId ?? null,
    projectId: codingRule?.defaultProjectId ?? null,
    postedBy: `human:${userId}`,
  });

  log.info('Capture event posted', {
    eventId, documentId, invoiceId: invoice.id,
    supplier: supplierMatch.supplierName,
    gateOutcome: gateDecision.outcome,
  }, 'capture-post');

  // Attempt to attach evidence to a matching provisional JE (best-effort, non-blocking)
  let provisionalAttach: { attachedJeId: string | null; bankTxId: string | null } = { attachedJeId: null, bankTxId: null };
  try {
    provisionalAttach = await attachEvidenceToProvisional(
      companyId,
      documentId,
      supplierMatch.supplierId,
      invoiceInput.totalAmount,
      invoiceInput.invoiceDate,
    );
  } catch (attachErr) {
    log.warn('Evidence attach to provisional JE failed — continuing', { eventId, error: attachErr }, 'capture-post');
  }

  // Best-effort alert resolution — non-blocking
  resolvePendingAlertForInvoice(
    companyId,
    supplierMatch.supplierId,
    invoice.id as string,
    invoiceInput.invoiceDate,
  ).catch((err: unknown) => {
    log.warn('resolvePendingAlertForInvoice failed (non-blocking)', { invoiceId: invoice.id, error: err }, 'capture-post');
  });

  // Run 3-way match if the invoice has a linked PO; non-blocking on error
  let threeWayMatch: Awaited<ReturnType<typeof performThreeWayMatch>> | null = null;
  try {
    threeWayMatch = await performThreeWayMatch(companyId, invoice.id as string);
  } catch (matchErr) {
    log.error('3-way match failed post-capture-post — continuing', { invoiceId: invoice.id, error: matchErr }, 'capture-post');
  }

  if (publishedDecision.outcome === 'route_review') {
    return apiResponse.success(res, {
      invoice: { id: invoice.id, invoiceNumber: invoice.invoice_number, status: invoice.status },
      supplierMatch: { name: supplierMatch.supplierName, confidence: supplierMatch.confidence },
      pipelineConfidence,
      approvalRoute,
      warnings: validation.warnings,
      reason: 'routed for review',
      reasons: publishedDecision.reasons,
      threeWayMatch,
      provisionalAttach,
    });
  }

  return apiResponse.success(res, {
    invoice: { id: invoice.id, invoiceNumber: invoice.invoice_number, status: invoice.status },
    supplierMatch: { name: supplierMatch.supplierName, confidence: supplierMatch.confidence },
    pipelineConfidence,
    approvalRoute,
    warnings: validation.warnings,
    gateOutcome: publishedDecision.outcome,
    gateReason: publishedDecision.reason,
    threeWayMatch,
    provisionalAttach,
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
