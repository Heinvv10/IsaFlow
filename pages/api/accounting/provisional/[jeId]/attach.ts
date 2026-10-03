/**
 * PRD-05 Phase 5 — Bank-first inverted workflow
 * POST /api/accounting/provisional/[jeId]/attach
 * Body: { capturedDocumentId: string }
 *
 * Manual attach: user confirms which captured document evidences a given
 * provisional JE. Bypasses the fuzzy matching, but not the capture posting
 * claim: the provisional JE has already expensed the bank line, so the slip is
 * claimed (`posted_at`) and cannot be posted again (R-107). Locks, refusals and
 * writes live in `provisionalEvidenceAttach`.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { respondRowHeld } from '@/lib/apiDocumentLock';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const jeId = req.query.jeId;
  if (typeof jeId !== 'string' || !UUID.test(jeId)) return apiResponse.badRequest(res, 'jeId must be a uuid');

  const { capturedDocumentId } = (req.body ?? {}) as { capturedDocumentId?: unknown };
  if (typeof capturedDocumentId !== 'string' || !UUID.test(capturedDocumentId)) {
    return apiResponse.badRequest(res, 'capturedDocumentId must be a uuid');
  }

  const result = await attachDocumentToProvisional(companyId, jeId, capturedDocumentId);
  switch (result.kind) {
    case 'not_found':
      return apiResponse.notFound(res, result.what, result.id);
    case 'refused':
      return apiResponse.badRequest(res, result.message);
    case 'contended':
      // A held bank line or captured document (a lock timeout or deadlock, nothing written): 503 + Retry-After,
      // as on every route into a D8 flow (round 18). Refusals about the document's state are 'refused', 400.
      return respondRowHeld(res, result.message, 'PROVISIONAL_ATTACH_CONTENDED');
    case 'attached':
      break;
  }

  log.info('Manual evidence attach to provisional JE', {
    companyId,
    jeId,
    capturedDocumentId,
    bankTxId: result.bankTxId,
  }, 'provisional-attach');

  return apiResponse.success(res, {
    jeId,
    capturedDocumentId,
    bankTxId: result.bankTxId,
    evidenced: true,
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
