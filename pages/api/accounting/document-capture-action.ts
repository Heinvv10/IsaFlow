/**
 * Document Capture Action API
 * POST /api/accounting/document-capture-action
 *   { id, action: 'confirm' | 'match_bank_tx' | 'reject', data?: {...} }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { CapturedDocumentAction, CapturedDocument } from '@/modules/accounting/types/documentCapture.types';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';

function mapRow(row: Record<string, unknown>): CapturedDocument {
  return {
    id: row.id as string,
    fileName: row.file_name as string,
    fileType: row.file_type as string,
    fileSize: row.file_size as number | null,
    documentType: row.document_type as string | null,
    extractedData: row.extracted_data ? (typeof row.extracted_data === 'string' ? JSON.parse(row.extracted_data as string) : row.extracted_data) : null,
    vendorName: row.vendor_name as string | null,
    documentDate: row.document_date ? fmtDate(row.document_date) : null,
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

  const { companyId } = req as CompanyAuthedRequest;

  // Verify document exists and belongs to this company
  const [existing] = await sql`
    SELECT * FROM captured_documents WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  ` as Record<string, unknown>[];

  if (!existing) {
    return apiResponse.notFound(res, 'Captured document', id);
  }

  try {
    if (action === 'confirm') {
      return handleConfirm(res, id, companyId, data);
    }

    if (action === 'match_bank_tx') {
      const { user } = req as CompanyAuthedRequest;
      return handleMatchBankTx(res, id, companyId, user?.id ?? null, data);
    }

    if (action === 'reject') {
      return handleReject(res, id, companyId, data);
    }

    return apiResponse.badRequest(res, 'Unknown action');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Document capture action failed', { error: msg, action, id }, 'document-capture');
    return apiResponse.internalError(res, err, `Action failed: ${msg}`);
  }
}

/**
 * Confirm — mark as reviewed, optionally update extracted fields.
 *
 * `AND posted_at IS NULL` is load-bearing, not tidiness. This UPDATE used to
 * reset `status` to 'reviewed' unconditionally, and `status` was the posting
 * fence — so post, confirm, post gave two posted journals and a doubled bank
 * credit against one R1 150 receipt in three ordinary UI clicks. The fence has
 * moved to `posted_at`, which this route must never write; refusing outright is
 * the honest answer, because editing the extracted amounts of a document that
 * is already in the ledger would silently desynchronise the two.
 */
async function handleConfirm(
  res: NextApiResponse,
  id: string,
  companyId: string,
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
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      AND posted_at IS NULL
    RETURNING *
  ` as Record<string, unknown>[];

  if (!row) return refusePostedOrMissing(res, id, companyId, 'confirmed');

  log.info('Document confirmed', { id }, 'document-capture');
  return apiResponse.success(res, mapRow(row as Record<string, unknown>), 'Document confirmed');
}

/** Match to bank transaction (and mirror the file into bank_transaction_attachments) */
async function handleMatchBankTx(
  res: NextApiResponse,
  id: string,
  companyId: string,
  userId: string | null,
  data?: Record<string, unknown>,
) {
  const bankTxId = data?.bankTxId as string;
  if (!bankTxId) {
    return apiResponse.badRequest(res, 'bankTxId is required for match_bank_tx action');
  }

  const result = await attachCapturedDocToBankTx(companyId, id, bankTxId, userId);
  if (!result.ok) {
    return result.reason === 'bank_tx_not_found'
      ? apiResponse.notFound(res, 'Bank transaction', bankTxId)
      : apiResponse.notFound(res, 'Captured document', id);
  }

  const [row] = await sql`
    SELECT * FROM captured_documents WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  ` as Record<string, unknown>[];

  if (!row) {
    return apiResponse.notFound(res, 'Captured document', id);
  }

  log.info('Document matched to bank transaction', { id, bankTxId, mirrored: result.mirrored }, 'document-capture');
  return apiResponse.success(
    res,
    { ...mapRow(row as Record<string, unknown>), mirrored: result.mirrored },
    'Document matched to bank transaction',
  );
}

/**
 * Reject — mark as rejected.
 *
 * Same `posted_at IS NULL` predicate as confirm, for the same reason: a
 * document already in the ledger cannot be un-posted by a lifecycle button.
 */
async function handleReject(
  res: NextApiResponse,
  id: string,
  companyId: string,
  data?: Record<string, unknown>,
) {
  const notes = (data?.notes as string) || null;

  const [row] = await sql`
    UPDATE captured_documents
    SET status = 'rejected',
        notes = COALESCE(${notes}, notes)
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      AND posted_at IS NULL
    RETURNING *
  ` as Record<string, unknown>[];

  if (!row) return refusePostedOrMissing(res, id, companyId, 'rejected');

  log.info('Document rejected', { id }, 'document-capture');
  return apiResponse.success(res, mapRow(row as Record<string, unknown>), 'Document rejected');
}


/**
 * Tell the two cases apart after a predicated UPDATE matched nothing: a
 * document belonging to another tenant (or gone) is a 404, one already posted
 * is a 400 that names the reason. Answering "not found" for both would send an
 * accountant looking for a document that is sitting in front of them.
 */
async function refusePostedOrMissing(
  res: NextApiResponse,
  id: string,
  companyId: string,
  action: 'confirmed' | 'rejected',
) {
  const [existing] = await sql`
    SELECT posted_at FROM captured_documents
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  ` as Record<string, unknown>[];

  if (!existing) return apiResponse.notFound(res, 'Captured document', id);

  log.info('Document lifecycle action refused — already posted', { id, action }, 'document-capture');
  return apiResponse.badRequest(
    res,
    `Document is already posted to the ledger and cannot be ${action}. Reverse the journal or invoice first.`,
  );
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
