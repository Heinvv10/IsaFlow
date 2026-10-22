/**
 * Document Capture Action API
 * POST /api/accounting/document-capture-action
 *   { id, action: 'confirm' | 'match_bank_tx' | 'reject' | 'retry', data?: {...} }
 *
 * 'retry' re-runs a failed or interrupted read from the stored upload (captureReadRetry).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { checkAiRateLimit } from '@/lib/rateLimit';
import type { CapturedDocumentAction } from '@/modules/accounting/types/documentCapture.types';
import { isBeingRead, STILL_BEING_READ } from '@/modules/accounting/services/capture/captureReadState';
import { mapCapturedDocumentRow as mapRow } from '@/modules/accounting/services/capture/capturedDocumentMapper';
import { retryCaptureRead, type RetryRefusal } from '@/modules/accounting/services/capture/captureReadRetry';
import { attachCapturedDocToBankTx } from '@/modules/accounting/services/capture/captureBankTxAttachService';
import {
  type LifecycleGate,
  releaseClaimForLifecycleAction,
} from '@/modules/accounting/services/capture/captureLifecycleGate';

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

  if (!['confirm', 'match_bank_tx', 'reject', 'retry'].includes(action)) {
    return apiResponse.badRequest(res, 'Invalid action. Allowed: confirm, match_bank_tx, reject, retry');
  }

  const { companyId } = req as CompanyAuthedRequest;

  if (action === 'retry') return handleRetry(req, res, id, companyId);

  // Verify document exists and belongs to this company
  const [existing] = await sql`
    SELECT * FROM captured_documents WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  ` as Record<string, unknown>[];

  if (!existing) {
    return apiResponse.notFound(res, 'Captured document', id);
  }

  try {
    if (action === 'confirm' || action === 'reject') {
      // A posting claim whose journal is still a DRAFT is not a posting. The
      // routes claim the document before their first ledger write, and
      // `receipt-to-journal` only POSTS what clears the auto-post gate — over
      // R5 000, or below 0.85 confidence, it leaves a draft and the claim
      // behind it. Both buttons then refused, the re-post refused, and
      // `reverseJournalEntry` refuses a draft: the ordinary capture path had no
      // way back at all. `releaseUnpostedCaptureClaim` discards that draft and
      // hands the claim back; anything LIVE in the ledger still refuses, and
      // refuses having written nothing.
      let gate: LifecycleGate;
      try {
        gate = await releaseClaimForLifecycleAction(companyId, id, action);
      } catch (err) {
        if (respondIfLockTimeout(res, err)) return;
        throw err;
      }
      if (gate === 'missing') return apiResponse.notFound(res, 'Captured document', id);
      if (gate === 'reading') return apiResponse.conflict(res, STILL_BEING_READ);
      if (gate === 'refused') {
        return refusePosted(res, id, action === 'confirm' ? 'confirmed' : 'rejected');
      }
    }

    if (action === 'confirm') {
      return handleConfirm(res, id, companyId, data);
    }

    if (action === 'match_bank_tx') {
      // A plain read is enough: reading -> done is one-way, so a row seen done cannot go back to reading.
      if (isBeingRead(existing)) return apiResponse.conflict(res, STILL_BEING_READ);
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

/** What each refusal of a retry answers. None of them has written anything. */
function refuseRetry(res: NextApiResponse, id: string, reason: RetryRefusal) {
  switch (reason) {
    case 'missing': return apiResponse.notFound(res, 'Captured document', id);
    case 'being_read': return apiResponse.conflict(res, STILL_BEING_READ);
    case 'too_many': return apiResponse.tooManyRequests(res, 'Too many documents are being read — wait for one to finish.');
    case 'rate_limited': return apiResponse.tooManyRequests(res, 'AI request limit reached. Please slow down and try again later.');
    default: return apiResponse.badRequest(res, 'This document cannot be retried — upload it again.');
  }
}

/**
 * Retry — read a failed or interrupted upload again from Storage. Charges the upload's AI bucket (no refund: the read
 * runs after COMMIT, where use cannot be recorded — quotaCallerCensus).
 */
async function handleRetry(req: NextApiRequest, res: NextApiResponse, id: string, companyId: string) {
  try {
    const out = await retryCaptureRead(
      companyId, id, () => checkAiRateLimit(req, companyId, 'document-capture', { companyMax: 30, dailyMax: 300 }),
    );
    if (!out.ok) return refuseRetry(res, id, out.reason);
    log.info('Document read retried', { id, attempt: out.attempt }, 'document-capture');
    return apiResponse.success(res, mapRow(out.row), 'Reading the document again');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Document capture retry failed', { error: msg, id }, 'document-capture');
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
 * The document is in the ledger for real: a posted journal, an uncancelled
 * supplier invoice, or a claim still in flight. The remedy named has to be one
 * that exists — reversing a DRAFT throws, and the claim journal carries no
 * source document, so rejecting the claim is the undo there.
 */
function refusePosted(
  res: NextApiResponse,
  id: string,
  action: 'confirmed' | 'rejected',
) {
  log.info('Document lifecycle action refused — already posted', { id, action }, 'document-capture');
  return apiResponse.badRequest(
    res,
    `Document is already posted to the ledger and cannot be ${action}. `
    + 'Reverse the journal, cancel the supplier invoice, or reject the expense claim first.',
  );
}

/**
 * Tell the two cases apart after a predicated UPDATE matched nothing: a
 * document belonging to another tenant (or gone) is a 404, one already posted
 * is a 400 that names the reason. Answering "not found" for both would send an
 * accountant looking for a document that is sitting in front of them.
 *
 * Reachable only when the row was re-claimed between the gate above and the
 * UPDATE — which the document lock is there to prevent — or when it vanished.
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
  return refusePosted(res, id, action);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
