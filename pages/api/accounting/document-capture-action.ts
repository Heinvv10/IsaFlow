/**
 * Document Capture Action API
 * POST /api/accounting/document-capture-action
 *   { id, action: 'confirm' | 'match_bank_tx' | 'reject', data?: {...} }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { CapturedDocumentAction, CapturedDocument } from '@/modules/accounting/types/documentCapture.types';

function mapRow(row: Record<string, unknown>): CapturedDocument {
  return {
    id: row.id as string,
    fileName: row.file_name as string,
    fileType: row.file_type as string,
    fileSize: row.file_size as number | null,
    documentType: row.document_type as string | null,
    extractedData: row.extracted_data ? (typeof row.extracted_data === 'string' ? JSON.parse(row.extracted_data as string) : row.extracted_data) : null,
    vendorName: row.vendor_name as string | null,
    documentDate: row.document_date ? new Date(row.document_date as string).toISOString().split('T')[0]! : null,
    referenceNumber: row.reference_number as string | null,
    totalAmount: row.total_amount !== null && row.total_amount !== undefined ? parseFloat(String(row.total_amount)) : null,
    vatAmount: row.vat_amount !== null && row.vat_amount !== undefined ? parseFloat(String(row.vat_amount)) : null,
    status: (row.status as CapturedDocument['status']) || 'pending',
    matchedInvoiceId: row.matched_invoice_id as string | null,
    matchedBankTxId: row.matched_bank_tx_id as string | null,
    notes: row.notes as string | null,
    uploadedBy: row.uploaded_by as string | null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { id, action, data } = req.body as {
    id: string;
    action: CapturedDocumentAction;
    data?: Record<string, unknown>;
  };

  if (!id || !action) {
    return apiResponse.badRequest(res, 'Missing required fields: id, action');
  }

  if (!['confirm', 'match_bank_tx', 'reject'].includes(action)) {
    return apiResponse.badRequest(res, 'Invalid action. Allowed: confirm, match_bank_tx, reject');
  }

  const { companyId } = req as CompanyApiRequest;

  // Verify document exists
  const [existing] = await sql`
    SELECT * FROM captured_documents WHERE id = ${id}::uuid AND company_id = ${companyId}
  ` as Record<string, unknown>[];

  if (!existing) {
    return apiResponse.notFound(res, 'Captured document', id);
  }

  try {
    if (action === 'confirm') {
      return handleConfirm(res, id, data);
    }

    if (action === 'match_bank_tx') {
      return handleMatchBankTx(res, id, data);
    }

    if (action === 'reject') {
      return handleReject(res, id, data);
    }

    return apiResponse.badRequest(res, 'Unknown action');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Document capture action failed', { error: msg, action, id }, 'document-capture');
    return apiResponse.internalError(res, err, `Action failed: ${msg}`);
  }
}

/** Confirm — mark as reviewed, optionally update extracted fields */
async function handleConfirm(
  res: NextApiResponse,
  id: string,
  data?: Record<string, unknown>,
) {
  const updates: Record<string, unknown> = {};
  if (data?.vendorName !== undefined) updates.vendor_name = data.vendorName;
  if (data?.documentDate !== undefined) updates.document_date = data.documentDate;
  if (data?.referenceNumber !== undefined) updates.reference_number = data.referenceNumber;
  if (data?.totalAmount !== undefined) updates.total_amount = data.totalAmount;
  if (data?.vatAmount !== undefined) updates.vat_amount = data.vatAmount;
  if (data?.documentType !== undefined) updates.document_type = data.documentType;
  if (data?.notes !== undefined) updates.notes = data.notes;

  const [row] = await sql`
    UPDATE captured_documents
    SET status = 'reviewed',

        vendor_name = COALESCE(${(updates.vendor_name as string) || null}, vendor_name),
        document_date = COALESCE(${(updates.document_date as string) || null}::date, document_date),
        reference_number = COALESCE(${(updates.reference_number as string) || null}, reference_number),
        total_amount = COALESCE(${updates.total_amount !== undefined ? Number(updates.total_amount) : null}::numeric, total_amount),
        vat_amount = COALESCE(${updates.vat_amount !== undefined ? Number(updates.vat_amount) : null}::numeric, vat_amount),
        document_type = COALESCE(${(updates.document_type as string) || null}, document_type),
        notes = COALESCE(${(updates.notes as string) || null}, notes)
    WHERE id = ${id}::uuid
    RETURNING *
  ` as Record<string, unknown>[];

  log.info('Document confirmed', { id }, 'document-capture');
  return apiResponse.success(res, mapRow(row as Record<string, unknown>), 'Document confirmed');
}

/** Match to bank transaction */
async function handleMatchBankTx(
  res: NextApiResponse,
  id: string,
  data?: Record<string, unknown>,
) {
  const bankTxId = data?.bankTxId as string;
  if (!bankTxId) {
    return apiResponse.badRequest(res, 'bankTxId is required for match_bank_tx action');
  }

  // Verify bank transaction exists
  const [bankTx] = await sql`
    SELECT id FROM bank_transactions WHERE id = ${bankTxId}::uuid
  ` as Record<string, unknown>[];

  if (!bankTx) {
    return apiResponse.notFound(res, 'Bank transaction', bankTxId);
  }

  const [row] = await sql`
    UPDATE captured_documents
    SET status = 'matched',
        matched_bank_tx_id = ${bankTxId}::uuid
    WHERE id = ${id}::uuid
    RETURNING *
  ` as Record<string, unknown>[];

  log.info('Document matched to bank transaction', { id, bankTxId }, 'document-capture');
  return apiResponse.success(res, mapRow(row as Record<string, unknown>), 'Document matched to bank transaction');
}

/** Reject — mark as rejected */
async function handleReject(
  res: NextApiResponse,
  id: string,
  data?: Record<string, unknown>,
) {
  const notes = (data?.notes as string) || null;

  const [row] = await sql`
    UPDATE captured_documents
    SET status = 'rejected',
        notes = COALESCE(${notes}, notes)
    WHERE id = ${id}::uuid
    RETURNING *
  ` as Record<string, unknown>[];

  log.info('Document rejected', { id }, 'document-capture');
  return apiResponse.success(res, mapRow(row as Record<string, unknown>), 'Document rejected');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
