/**
 * POST /api/accounting/purchase-orders/[id]/cancel (budgets P5-3 review r2)
 * Body: { reason: string (1-2 000) }
 *
 * Cancels an APPROVED PO against which no goods have been received (`ap/purchaseOrderCancel`), releasing its
 * commitment from remaining budget; audited with the reason. Draft / submitted orders are cancelled through the
 * PUT. Roles: owner, admin. Answers: 200 { ...purchase order }; 400 not cancellable (not approved, or goods
 * received); 403 role or Login-as session; 404 not this company's; 409 changed under the lock; 422 bad body;
 * 429 past 120 a minute per user; 503 + Retry-After when the PO row is held.
 */
import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { checkRateLimit } from '@/lib/rateLimit';
import { isUuidParam } from '@/lib/validation';
import { BUDGET_REASON_MAX } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { PurchaseOrderChangedError, PurchaseOrderNotFoundError } from '@/modules/accounting/services/ap/purchaseOrderErrors';
import { cancelApprovedPurchaseOrder, PurchaseOrderNotCancellableError } from '@/modules/accounting/services/ap/purchaseOrderCancel';
import { PO_CANCEL_ROLES } from '@/lib/auth/writeRoles';

const CancelSchema = z.object({ reason: z.string().trim().min(1).max(BUDGET_REASON_MAX) }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  if (!(await checkRateLimit(`purchase-order-cancel:${req.user.id}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many purchase order cancellations; wait a minute and try again.');
  }
  const id = req.query.id;
  if (typeof id !== 'string' || !isUuidParam(id)) return apiResponse.notFound(res, 'Purchase order');
  const parsed = CancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  try {
    return apiResponse.success(res, await cancelApprovedPurchaseOrder(companyId, id, req.user.id, parsed.data.reason));
  } catch (err) {
    if (err instanceof PurchaseOrderNotFoundError) return apiResponse.notFound(res, 'Purchase order');
    if (err instanceof PurchaseOrderNotCancellableError) return apiResponse.badRequest(res, err.message);
    if (err instanceof PurchaseOrderChangedError) return apiResponse.conflict(res, err.message);
    if (respondIfImpersonationForbidden(res, err)) return;
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: [...PO_CANCEL_ROLES] }))));
