/**
 * PRD-05 Phase 5 — Bank-first inverted workflow
 * POST /api/accounting/provisional/[jeId]/attach
 * Body: { capturedDocumentId: string }
 *
 * Manual attach: user confirms which captured document evidences a given
 * provisional JE. Bypasses the fuzzy matching — direct update.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const jeId = req.query.jeId as string;
  if (!jeId) return apiResponse.badRequest(res, 'jeId is required');

  const { capturedDocumentId } = req.body as { capturedDocumentId?: string };
  if (!capturedDocumentId) return apiResponse.badRequest(res, 'capturedDocumentId is required');

  // Verify the JE belongs to this company and is still provisional
  const [jeRow] = (await sql`
    SELECT id, needs_evidence FROM gl_journal_entries
    WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  if (!jeRow) return apiResponse.notFound(res, 'Journal entry', jeId);

  if (!jeRow.needs_evidence) {
    return apiResponse.badRequest(res, 'Journal entry is already evidenced');
  }

  // Verify the document belongs to this company
  const [docRow] = (await sql`
    SELECT id, source_document_hash, extraction_confidence
    FROM captured_documents
    WHERE id = ${capturedDocumentId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  if (!docRow) return apiResponse.notFound(res, 'Captured document', capturedDocumentId);

  const docHash = docRow.source_document_hash ? String(docRow.source_document_hash) : null;
  const docConfidence = docRow.extraction_confidence != null ? Number(docRow.extraction_confidence) : null;

  // (1) THE BANK LINE FIRST, then (4) the journal — the canonical order in
  // `src/modules/accounting/services/bank/.claude.md`. These two writes used to
  // run the other way round, which is the inverse of every settlement path that
  // locks a bank line and later reaches a PRE-EXISTING journal
  // (`reverseReconciledTransaction`, `voidPaymentDocument`). The two statements
  // are independent — the bank UPDATE is keyed on `provisional_je_id` and reads
  // nothing the journal UPDATE sets — so only the order changes.
  const [btRow] = (await sql`
    UPDATE bank_transactions
    SET status = 'matched'
    WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id
  `) as Row[];

  // Direct flip — no matching check (user has confirmed)
  await sql`
    UPDATE gl_journal_entries
    SET source_document_id    = ${capturedDocumentId}::UUID,
        source_document_hash  = ${docHash},
        posting_agent         = 'ai-evidenced:v1',
        needs_evidence        = false,
        evidenced_at          = NOW(),
        extraction_confidence = COALESCE(${docConfidence}, extraction_confidence)
    WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID
  `;

  const bankTxId = btRow ? String(btRow.id) : null;

  log.info('Manual evidence attach to provisional JE', {
    companyId,
    jeId,
    capturedDocumentId,
    bankTxId,
  }, 'provisional-attach');

  return apiResponse.success(res, {
    jeId,
    capturedDocumentId,
    bankTxId,
    evidenced: true,
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
