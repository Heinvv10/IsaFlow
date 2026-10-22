/**
 * /api/accounting/expense-claims/[id]
 *   GET    — claim + lines
 *   POST   — add a line (draft only)
 *   DELETE — hard-delete the claim (cascades lines)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondRowHeld } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import {
  getClaim,
  addLine,
  type ExpenseClaimLine,
} from '@/modules/accounting/services/expense/expenseClaimService';
import {
  ClaimSourceDocumentError,
  PartialSourceDocumentClaimError,
  lockClaimReadSourceDocumentIds,
  releaseSourceDocuments,
} from '@/modules/accounting/services/expense/claimSourceDocuments';
import { DocumentLineAccountRefusal } from '@/modules/accounting/services/gl/documentLineAccountGuard';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const id = req.query.id as string;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Expense claim', id);

  if (req.method === 'GET') {
    const claim = await getClaim(id, companyId);
    if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
    return apiResponse.success(res, { claim });
  }

  if (req.method === 'POST') {
    const line = req.body as ExpenseClaimLine;
    if (!line.lineDate || !line.amount) {
      return apiResponse.badRequest(res, 'lineDate and amount are required');
    }
    try {
      const claim = await addLine(id, companyId, line);
      if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
      return apiResponse.success(res, { claim });
    } catch (err) {
      // Stamps were written: this must reach a 5xx so the request rolls back.
      if (err instanceof PartialSourceDocumentClaimError) throw err;
      if (err instanceof ClaimSourceDocumentError) {
        // A receipt fingerprint a peer holds past the bounded wait is a held lock: 503 + Retry-After (D11).
        if (err.refusal === 'busy') return respondRowHeld(res, err.message, 'RECEIPT_POST_BUSY');
        // The upload is still being read: nothing was written, and asking again later works.
        if (err.refusal === 'being_read') return apiResponse.conflict(res, err.message);
        return apiResponse.badRequest(res, err.message);
      }
      if (err instanceof DocumentLineAccountRefusal) return apiResponse.badRequest(res, err.message);
      return apiResponse.badRequestFromError(res, err, 'Request failed');
    }
  }

  if (req.method === 'DELETE') {
    // Read before the delete cascades the lines away, release after it (R-105).
    const documentIds = await lockClaimReadSourceDocumentIds(id, companyId);
    const rows = (await sql`
      DELETE FROM expense_claims
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
        AND status IN ('draft', 'cancelled', 'rejected')
      RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) {
      return apiResponse.badRequest(res, 'Claim not found or not deletable (must be draft/cancelled/rejected)');
    }
    await releaseSourceDocuments(companyId, documentIds);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
