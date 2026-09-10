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
import { refusesUnattendedApproval } from '@/modules/accounting/services/core/unattendedPostingGate';
import { decide } from '@/modules/accounting/services/capture/autoPublishGateService';
import { isCaptureEventPostable } from '@/modules/accounting/services/capture/captureEventLock';
import { computeFingerprint } from '@/modules/accounting/services/capture/captureDeduplicationService';
import {
  runCapturePostFollowUps,
  type PublishedDecision,
} from '@/modules/accounting/services/capture/capturePostFollowUps';
import {
  CAPTURED_DOCUMENT_REFUSAL_MESSAGE,
  CaptureRowLockTimeoutError,
  claimCapturedDocumentForPosting,
  lockCaptureEventForPosting,
  refusalForPosting,
} from '@/modules/accounting/services/capture/captureRowLock';

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

  // Load event + document, holding BOTH rows for the rest of the request.
  //
  // This is the only posting button in the product (capture/inbox.tsx), and it
  // read no document state at all: it selected `ce.status` and stamped
  // `captured_documents.status = 'matched'` at the end, so a receipt already
  // turned into a GL journal by receipt-to-journal could be posted again here
  // as an auto-approved supplier invoice carrying the same tax_amount — one
  // slip, the same input VAT in the VAT201 twice, no concurrency in it. The
  // event lock is also what makes the status refusal below meaningful (R-058):
  // two concurrent requests both read a postable status and both INSERT a
  // supplier_invoice. Nothing is written yet, so contention on either row is a
  // retryable 409 — the contract R-058 gave this route.
  let event;
  try {
    event = await lockCaptureEventForPosting(companyId, eventId);
  } catch (err) {
    if (err instanceof CaptureRowLockTimeoutError) return apiResponse.conflict(res, err.message);
    throw err;
  }

  if (!event) {
    return apiResponse.notFound(res, 'Capture event', eventId);
  }

  // Postable is an ALLOW-list (`captureEventLock.ts`), not `status === 'posted'`.
  // Naming one value left every OTHER terminal state postable: a user could
  // discard a captured document and then post it anyway, with no race at all.
  if (!isCaptureEventPostable(event.eventStatus)) {
    return apiResponse.badRequest(
      res,
      event.eventStatus === 'posted'
        ? 'Event already posted'
        : `Event cannot be posted from status '${event.eventStatus}'`,
    );
  }

  const readRefusal = refusalForPosting({
    status: event.documentStatus,
    posted_at: event.documentPostedAt,
  });
  if (readRefusal) {
    return apiResponse.badRequest(res, CAPTURED_DOCUMENT_REFUSAL_MESSAGE[readRefusal]);
  }

  if (!event.extractedData) {
    return apiResponse.badRequest(res, 'Document has no extracted data — extraction may still be in progress');
  }

  const documentId = event.documentId;
  const extracted = event.extractedData as ExtractedDocument;

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

  // A refund booked as a supplier invoice reverses the entry, and a document
  // whose own text prints more than one total approves a figure nobody chose:
  // measured on the k076 corpus, three mixed-basket slips were auto-approved
  // here at R230.00 against a payable of R253.00 — a WORSE figure than the
  // reader this branch replaced produced. Neither may go through unattended,
  // nor may figures the regex/OCR fallback recovered (K-072 round 14 policy),
  // and all three override `auto_publish`, whose rules judge the supplier and
  // the duplicate history rather than whether the amount is legible.
  const unattendedRefused = refusesUnattendedApproval(extracted);
  const approvalRoute = unattendedRefused
    ? 'manual_review'
    : determineApprovalRoute(pipelineConfidence, invoiceInput.totalAmount, DEFAULT_THRESHOLDS);

  const invoiceStatus = unattendedRefused
    ? 'draft'
    : gateDecision.outcome === 'auto_publish' ? 'approved' : (approvalRoute === 'auto_approve' ? 'approved' : 'draft');

  // Claim the document BEFORE the first ledger write, and AFTER the
  // duplicate-blocked branch above — that branch answers 409 having written the
  // event's 'failed' stamp, and `withAuth` COMMITs on a 4xx, so claiming any
  // earlier would leave a blocked document marked posted and unrecoverable.
  //
  // This is the last point at which a 4xx is safe here: everything above is a
  // SELECT or a pure function, and a refusal matched no row.
  const claimRefusal = await claimCapturedDocumentForPosting(companyId, documentId);
  if (claimRefusal) {
    return apiResponse.badRequest(res, CAPTURED_DOCUMENT_REFUSAL_MESSAGE[claimRefusal]);
  }

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

  // Record coding for the learning loop (both auto_publish and route_review paths).
  // At this point gateDecision is guaranteed to be auto_publish | route_review
  // (duplicate_blocked returned early above).
  const publishedDecision = gateDecision as PublishedDecision;
  const { provisionalAttach, threeWayMatch } = await runCapturePostFollowUps({
    companyId,
    userId,
    eventId,
    documentId,
    invoiceId: invoice.id as string,
    supplierId: supplierMatch.supplierId,
    supplierName: supplierMatch.supplierName,
    vendorVatNumber: extracted.vendorVatNumber,
    totalAmount: invoiceInput.totalAmount,
    invoiceDate: invoiceInput.invoiceDate,
    decision: publishedDecision,
  });

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
