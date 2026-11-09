/**
 * Re-apply payment terms to open customer invoices (payment-terms programme, AR parity with supplier-invoices-reapply-terms).
 * GET  ?customerId=UUID (optional)  the preview: which invoices' due dates the customers' terms would move, and to what.
 * POST { items: [{ id, dueDate, fromDueDate, fromSource }] } write exactly the confirmed invoices; one whose date or
 *      source moved since the preview, whose terms no longer give that date, or that is no longer open, is skipped
 *      with a reason (ar/reapplyTerms.ts).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { ReapplyRefusal } from '@/modules/accounting/services/shared/reapplyTermsShared';
import { applyReapplyCustomerTerms, previewReapplyCustomerTerms } from '@/modules/accounting/services/ar/reapplyTerms';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;
  try {
    if (req.method === 'GET') {
      const customerId = typeof req.query.customerId === 'string' && req.query.customerId !== '' ? req.query.customerId : undefined;
      return apiResponse.success(res, await previewReapplyCustomerTerms(companyId, { customerId }));
    }
    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await applyReapplyCustomerTerms(companyId, body.items);
      log.info('Payment terms re-applied to customer invoices', {
        updated: result.updated.length, skipped: result.skipped.length, userId: user.id,
      }, 'accounting-api');
      return apiResponse.success(res, result);
    }
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
  } catch (err) {
    // A refusal is raised before any write. Anything else is re-thrown, a lock timeout at a later invoice included:
    // withErrorHandler answers it 503 + Retry-After and withAuth rolls back the invoices already written (a 4xx would commit them).
    if (err instanceof ReapplyRefusal) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
