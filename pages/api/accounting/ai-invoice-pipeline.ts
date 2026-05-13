/**
 * AI Invoice Pipeline API
 * POST /api/accounting/ai-invoice-pipeline
 * Body: { documentId } — processes a captured document into a supplier invoice
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
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
import {
  computeFingerprint,
  findDuplicate,
} from '@/modules/accounting/services/capture/captureDeduplicationService';
import { recordCoding } from '@/modules/accounting/services/capture/supplierRulesService';
import { performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { attachEvidenceToProvisional } from '@/modules/accounting/services/capture/evidenceAttachmentService';
import { resolvePendingAlertForInvoice } from '@/modules/accounting/services/capture/alertResolutionService';

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
  const { documentId } = req.body as { documentId?: string };

  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  // Fetch captured document
  const [doc] = (await sql`
    SELECT extracted_data, status FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
  `) as Row[];

  if (!doc) return apiResponse.notFound(res, 'Captured document', documentId);
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
  const approvalRoute = determineApprovalRoute(pipelineConfidence, invoiceInput.totalAmount, DEFAULT_THRESHOLDS);

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

  // Create supplier invoice (evidence columns stamped; hash backfilled by worker)
  const [invoice] = (await sql`
    INSERT INTO supplier_invoices (
      company_id, invoice_number, supplier_id, invoice_date, due_date,
      subtotal, tax_rate, tax_amount, total_amount, payment_terms,
      reference, status, created_by,
      source_document_id, source_document_hash, extraction_confidence, posting_agent,
      duplicate_fingerprint
    ) VALUES (
      ${companyId}, ${invoiceInput.invoiceNumber}, ${supplierMatch.supplierId}::uuid,
      ${invoiceInput.invoiceDate}::date, ${invoiceInput.dueDate || null}::date,
      ${invoiceInput.totalAmount - invoiceInput.taxAmount}, ${invoiceInput.taxRate},
      ${invoiceInput.taxAmount}, ${invoiceInput.totalAmount},
      ${invoiceInput.paymentTerms || 'net30'}, ${invoiceInput.reference || null},
      ${approvalRoute === 'auto_approve' ? 'approved' : 'draft'},
      ${userId},
      ${documentId}::uuid, NULL, ${pipelineConfidence}, 'ai:ai-invoice-pipeline:v1',
      ${fingerprint}
    ) RETURNING id, invoice_number, status
  `) as Row[];

  if (!invoice) return apiResponse.internalError(res, null, 'Failed to create invoice');

  // Insert line items — unitPrice is VAT-exclusive (subtotal = sum of line totals;
  // vatAmount = subtotal * taxRate/100 per vlmInvoiceService validateAmounts).
  const round2 = (n: number) => Math.round(n * 100) / 100;
  for (const item of invoiceInput.items) {
    if (item.quantity <= 0 || item.unitPrice < 0) {
      log.warn('AI Invoice Pipeline: skipping invalid line item', { item, invoiceId: invoice.id }, 'ai-pipeline');
      continue;
    }
    const lineTotal = round2(item.quantity * item.unitPrice);
    const taxAmount = round2(lineTotal * item.taxRate / 100);
    await sql`
      INSERT INTO supplier_invoice_items (
        supplier_invoice_id, description, quantity, unit_price,
        tax_rate, tax_amount, line_total, company_id
      ) VALUES (
        ${invoice.id}::uuid, ${item.description}, ${item.quantity},
        ${item.unitPrice}, ${item.taxRate}, ${taxAmount}, ${lineTotal},
        ${companyId}
      )
    `;
  }

  // Link document to invoice
  await sql`
    UPDATE captured_documents
    SET matched_invoice_id = ${invoice.id}::uuid, status = 'matched'
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
  `;

  // Record coding for supplier learning loop (gl/vat/cc null — human review will code)
  await recordCoding(companyId, {
    supplierId: supplierMatch.supplierId,
    supplierInvoiceId: invoice.id,
    glAccountId: null,
    vatCode: null,
    costCentreId: null,
    projectId: null,
    postedBy: 'ai:ai-invoice-pipeline:v1',
  });

  // Run 3-way match if the invoice has a linked PO; non-blocking on error
  let threeWayMatch: Awaited<ReturnType<typeof performThreeWayMatch>> | null = null;
  try {
    threeWayMatch = await performThreeWayMatch(companyId, invoice.id as string);
  } catch (matchErr) {
    log.error('3-way match failed post-pipeline — continuing', { invoiceId: invoice.id, error: matchErr }, 'ai-pipeline');
  }

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
    log.warn('Evidence attach to provisional JE failed — continuing', { documentId, error: attachErr }, 'ai-pipeline');
  }

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
    invoice: { id: invoice.id, invoiceNumber: invoice.invoice_number, status: invoice.status },
    supplierMatch: { name: supplierMatch.supplierName, confidence: supplierMatch.confidence },
    pipelineConfidence,
    approvalRoute,
    warnings: validation.warnings,
    threeWayMatch,
    provisionalAttach,
  });
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
