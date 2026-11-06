/**
 * Re-apply payment terms to open supplier bills (payment-terms programme PR 3).
 * GET  ?supplierId=UUID (optional)  the preview: which bills' due dates the suppliers' terms would move, and to what.
 * POST { items: [{ id, dueDate }] } write exactly the confirmed pairs; a bill whose terms no longer give that date, or
 *                                   that is no longer open, is skipped with a reason (ap/reapplyTerms.ts).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { ReapplyRefusal, applyReapplyTerms, previewReapplyTerms } from '@/modules/accounting/services/ap/reapplyTerms';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;
  try {
    if (req.method === 'GET') {
      const supplierId = typeof req.query.supplierId === 'string' && req.query.supplierId !== '' ? req.query.supplierId : undefined;
      return apiResponse.success(res, await previewReapplyTerms(companyId, { supplierId }));
    }
    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await applyReapplyTerms(companyId, body.items);
      log.info('Payment terms re-applied to supplier bills', {
        updated: result.updated.length, skipped: result.skipped.length, userId: user.id,
      }, 'accounting-api');
      return apiResponse.success(res, result);
    }
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
  } catch (err) {
    // A refusal is raised before any write. Anything else is re-thrown, a lock timeout at a later bill included:
    // withErrorHandler answers it 503 + Retry-After and withAuth rolls back the bills already written (a 4xx would commit them).
    if (err instanceof ReapplyRefusal) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
