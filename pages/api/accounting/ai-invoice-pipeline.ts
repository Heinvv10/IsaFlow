/**
 * AI Invoice Pipeline API
 * POST /api/accounting/ai-invoice-pipeline
 * Body: { documentId } — processes a captured document into a supplier invoice
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { checkAiRateLimit } from '@/lib/rateLimit';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
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
import { computeFingerprint, findDuplicate } from '@/modules/accounting/services/capture/captureDeduplicationService';
import { getRule, recordCoding } from '@/modules/accounting/services/capture/supplierRulesService';
import { insertCaptureBillLines, planCaptureBillLines } from '@/modules/accounting/services/capture/captureBillLines';
import {
  CAPTURED_DOCUMENT_REFUSAL_ERROR_CODE, CAPTURED_DOCUMENT_REFUSAL_MESSAGE,
  CaptureRowLockTimeoutError,
  claimCapturedDocumentForPosting,
  lockCapturedDocumentForUpdate,
  lockPostableCaptureEventIds,
  markCaptureEventsDuplicate,
  markCaptureEventsPosted,
  refusalForPosting,
} from '@/modules/accounting/services/capture/captureRowLock';
import { performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import { resolvePendingAlertForInvoice } from '@/modules/accounting/services/capture/alertResolutionService';
import { raiseUnattendedApproval, unattendedBillStatus } from '@/modules/accounting/services/gl/approvalUnattended';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const DEFAULT_THRESHOLDS: PipelineThresholds = {
  autoApproveConfidence: 0.95,
  routeApprovalConfidence: 0.85,
  highValueAmount: 100000,
  lowValueAutoApproveAmount: 5000,
};

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const { companyId } = req;
  const userId: string = req.user?.id || '';

  if (!(await checkAiRateLimit(req, companyId, 'ai-invoice-pipeline', { companyMax: 30, dailyMax: 300 }))) {
    return apiResponse.tooManyRequests(res, 'AI request limit reached. Please slow down and try again later.');
  }

  const { documentId } = req.body as { documentId?: string };

  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  // Fetch captured document, HELD for the rest of the request.
  //
  // This is the fourth posting route, and until the lock and the claim below it
  // was the only one with neither. `capture/[id]/post` and this endpoint both
  // turn one captured document into a supplier invoice carrying its `tax_amount`
  // as input VAT; each merely stamped `status = 'matched'` at the end, which is
  // not a fence — `receipt-to-journal` then `ai-invoice-pipeline` on one R1 150
  // receipt produced a posted GL journal AND an auto-approved supplier invoice,
  // R150 of VAT claimed twice, R300 in the VAT201, no concurrency in it.
  //
  // The `uq_gl_je_capture_source_document` index behind the application claim
  // does NOT reach here: it is a unique index on `gl_journal_entries`, and this
  // route writes `supplier_invoices`. On this path the claim IS the whole fence.
  let doc;
  try {
    doc = await lockCapturedDocumentForUpdate(companyId, documentId);
  } catch (err) {
    if (err instanceof CaptureRowLockTimeoutError) return apiResponse.badRequest(res, err.message);
    throw err;
  }

  if (!doc) return apiResponse.notFound(res, 'Captured document', documentId);

  // R-169: no event id of its own, so lock whatever event(s) are tied to the
  // document here. None (a straight upload) is an empty array, not a refusal.
  let postableEventIds: string[];
  try {
    postableEventIds = await lockPostableCaptureEventIds(companyId, documentId);
  } catch (err) {
    if (err instanceof CaptureRowLockTimeoutError) return apiResponse.badRequest(res, err.message);
    throw err;
  }

  const readRefusal = refusalForPosting(doc);
  if (readRefusal) {
    return apiResponse.badRequest(res, CAPTURED_DOCUMENT_REFUSAL_MESSAGE[readRefusal]);
  }

  if (!doc.extracted_data) return apiResponse.badRequest(res, 'Document has no extracted data');

  const extracted = doc.extracted_data as ExtractedDocument;

  // Validate
  const validation = validatePipelineInput(extracted);
  if (!validation.valid) {
    return apiResponse.badRequest(res, `Validation failed: ${validation.errors.join(', ')}`);
  }

  // Match supplier
  const suppliers = (await sql`
    SELECT id, name FROM suppliers WHERE company_id = ${companyId} AND is_active = true
  `) as Row[];

  const supplierMatch = matchSupplierFromExtraction(extracted, suppliers.map(s => ({ id: s.id, name: s.name })));

  if (!supplierMatch) {
    return apiResponse.success(res, {
      status: 'manual_review',
      reason: `No matching supplier found for "${extracted.vendorName}"`,
      extractedVendor: extracted.vendorName,
      confidence: 0,
    });
  }

  // Build invoice
  const invoiceInput = buildInvoiceFromExtraction(extracted, supplierMatch.supplierId);
  const pipelineConfidence = computePipelineConfidence(extracted, supplierMatch);
  // A refund booked as a purchase reverses the entry, and a document whose own
  // text prints more than one total approves a number nobody chose: measured on
  // the k076 corpus, three mixed-basket slips were auto-approved here at
  // R230.00 against a payable of R253.00 — a WORSE figure than the reader this
  // branch replaced produced. Neither may be approved with nobody looking, and
  // nor may figures the regex/OCR fallback recovered (K-072 round 14 policy).
  const approvalRoute = refusesUnattendedApproval(extracted)
    ? 'manual_review'
    : determineApprovalRoute(pipelineConfidence, invoiceInput.totalAmount, DEFAULT_THRESHOLDS);

  // Fetch supplier VAT number (needed for fingerprint + duplicate detection)
  const [supplierRow] = (await sql`
    SELECT vat_number FROM suppliers
    WHERE id = ${supplierMatch.supplierId}::uuid AND company_id = ${companyId}
  `) as Row[];
  const supplierVatNumber: string | null = supplierRow?.vat_number ?? null;

  // Duplicate detection
  const dupHit = await findDuplicate(
    companyId,
    supplierMatch.supplierId,
    invoiceInput.invoiceNumber,
    invoiceInput.totalAmount,
    invoiceInput.invoiceDate,
    supplierVatNumber,
  );
  if (dupHit) {
    await sql`
      UPDATE captured_documents
      SET status = 'matched', matched_invoice_id = ${dupHit.supplierInvoiceId}::uuid
      WHERE id = ${documentId}::uuid AND company_id = ${companyId}
    `;
    // R-169 round 2: `capture/[id]/post`'s own duplicate_blocked branch stamps its event
    // 'failed'/'duplicate' before its 409 — this route wrote only captured_documents.
    await markCaptureEventsDuplicate(companyId, postableEventIds);
    log.info('AI Invoice Pipeline: duplicate detected', {
      documentId,
      supplierInvoiceId: dupHit.supplierInvoiceId,
      dupConfidence: dupHit.confidence,
    }, 'ai-pipeline');
    return apiResponse.error(res, ErrorCode.CONFLICT, 'Duplicate supplier invoice', {
      hit: dupHit,
      supplierMatch: { name: supplierMatch.supplierName, confidence: supplierMatch.confidence },
      extractedVendor: extracted.vendorName,
    });
  }

  const fingerprint = computeFingerprint(supplierVatNumber, invoiceInput.invoiceNumber, invoiceInput.totalAmount);
  // R-035 (B2): under an enforced approval rule an auto-approval becomes a draft plus a request.
  const approval = await unattendedBillStatus(companyId, approvalRoute === 'auto_approve', invoiceInput.totalAmount);
  // R-160: R-131's lines or a refusal, before the claim so a 4xx commits nothing. No capture event account: this
  // route reads no event, and an event gets one only when posted as an expense, which claims the document first.
  const codingRule = await getRule(companyId, supplierMatch.supplierId);
  const linePlan = await planCaptureBillLines(companyId, invoiceInput, extracted.lineItems?.length ?? 0, null, codingRule);
  if ('refusal' in linePlan) return apiResponse.badRequest(res, linePlan.refusal);

  // Claim the document BEFORE the first ledger write, and AFTER the
  // duplicate-blocked branch above — that branch answers 409 having already
  // written `status`/`matched_invoice_id`, and `withAuth` COMMITs on a 4xx, so
  // claiming any earlier would leave a document that produced NO invoice marked
  // posted and unrecoverable.
  //
  // This is the last point at which a 4xx is safe here: everything between the
  // duplicate branch and this line is a SELECT or a pure function, and a refusal
  // matched no row.
  const claimRefusal = await claimCapturedDocumentForPosting(companyId, documentId, null, { spend: 'invoice' });
  if (claimRefusal) {
    return apiResponse.error(res, CAPTURED_DOCUMENT_REFUSAL_ERROR_CODE[claimRefusal], CAPTURED_DOCUMENT_REFUSAL_MESSAGE[claimRefusal]);
  }

  // Create supplier invoice (evidence columns stamped; hash backfilled by worker)
  const [invoice] = (await sql`
    INSERT INTO supplier_invoices (
      company_id, invoice_number, supplier_id, invoice_date, due_date,
      subtotal, tax_rate, tax_amount, total_amount, payment_terms,
      reference, status, created_by, notes,
      source_document_id, source_document_hash, extraction_confidence, posting_agent,
      duplicate_fingerprint
    ) VALUES (
      ${companyId}, ${invoiceInput.invoiceNumber}, ${supplierMatch.supplierId}::uuid,
      ${invoiceInput.invoiceDate}::date, ${invoiceInput.dueDate || null}::date,
      ${invoiceInput.totalAmount - invoiceInput.taxAmount}, ${invoiceInput.taxRate},
      ${invoiceInput.taxAmount}, ${invoiceInput.totalAmount},
      ${invoiceInput.paymentTerms || 'net30'}, ${invoiceInput.reference || null},
      ${approval.status},
      ${userId}, ${invoiceInput.notes ?? null},
      ${documentId}::uuid, NULL, ${pipelineConfidence}, 'ai:ai-invoice-pipeline:v1',
      ${fingerprint}
    ) RETURNING id, invoice_number, status
  `) as Row[];

  if (!invoice) return apiResponse.internalError(res, null, 'Failed to create invoice');

  await insertCaptureBillLines(invoice.id as string, linePlan.lines);
  const approvalRequest = approval.gated // after the lines: the request binds to their digest
    ? await raiseUnattendedApproval(companyId, 'supplier_invoice', invoice.id as string, userId) : null;
  // Link document to invoice
  await sql`
    UPDATE captured_documents
    SET matched_invoice_id = ${invoice.id}::uuid, status = 'matched'
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
  `;

  // Mark the tied capture event(s) posted (R-169), as `capturePostFollowUps` does for its event id.
  await markCaptureEventsPosted(companyId, postableEventIds, userId);

  // Record coding for the learning loop: the rule's account (R-169), same as
  // `capturePostFollowUps` records for `capture/[id]/post` — never the
  // pipeline's own guess, so an unruled supplier still seeds nothing here.
  await recordCoding(companyId, {
    supplierId: supplierMatch.supplierId,
    supplierInvoiceId: invoice.id,
    glAccountId: codingRule?.defaultGlAccountId ?? null,
    vatCode: codingRule?.defaultVatCode ?? extracted.vendorVatNumber ?? null,
    costCentreId: codingRule?.defaultCostCentreId ?? null,
    projectId: codingRule?.defaultProjectId ?? null,
    postedBy: 'ai:ai-invoice-pipeline:v1',
  });

  // Run 3-way match if the invoice has a linked PO; non-blocking on error
  let threeWayMatch: Awaited<ReturnType<typeof performThreeWayMatch>> | null = null;
  try {
    threeWayMatch = await performThreeWayMatch(companyId, invoice.id as string);
  } catch (matchErr) {
    log.error('3-way match failed post-pipeline — continuing', { invoiceId: invoice.id, error: matchErr }, 'ai-pipeline');
  }

  // Attach evidence to a matching provisional JE; an auto-approved invoice is then
  // settled against it (R-127), or posted on its own when it evidences none (R-160),
  // and withdrawn to draft when its journal cannot post. Throws only if that revert fails.
  const provisionalAttach = await attachEvidenceAndSettleApproved({
    companyId, userId, documentId, invoiceId: invoice.id as string, invoiceStatus: String(invoice.status),
    supplierId: supplierMatch.supplierId, totalAmount: invoiceInput.totalAmount, invoiceDate: invoiceInput.invoiceDate,
    postUnattached: true,
  });

  // Best-effort alert resolution — non-blocking
  resolvePendingAlertForInvoice(
    companyId,
    supplierMatch.supplierId,
    invoice.id as string,
    invoiceInput.invoiceDate,
  ).catch((err: unknown) => {
    log.warn('resolvePendingAlertForInvoice failed (non-blocking)', { invoiceId: invoice.id, error: err }, 'ai-pipeline');
  });

  log.info('AI Invoice Pipeline completed', {
    documentId, invoiceId: invoice.id, supplierMatch: supplierMatch.supplierName,
    confidence: pipelineConfidence, route: approvalRoute,
    itemCount: invoiceInput.items.length,
    matchStatus: threeWayMatch?.matchStatus ?? 'skipped',
    provisionalAttach,
  }, 'ai-pipeline');

  return apiResponse.success(res, {
    invoice: { id: invoice.id, invoiceNumber: invoice.invoice_number, status: provisionalAttach.settlementRefused ? 'draft' : invoice.status },
    supplierMatch: { name: supplierMatch.supplierName, confidence: supplierMatch.confidence },
    pipelineConfidence,
    approvalRoute: provisionalAttach.settlementRefused ? 'manual_review' : approvalRoute,
    warnings: validation.warnings,
    threeWayMatch,
    provisionalAttach, approvalRequired: approval.gated, approvalRequest,
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
