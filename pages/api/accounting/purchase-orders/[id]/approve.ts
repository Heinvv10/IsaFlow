/**
 * POST /api/accounting/purchase-orders/[id]/approve (budgets P5-3, spec §0 decision 8c, §4)
 * Body: { budgetReason?: string (≤ 2 000), budgetOverride?: boolean }
 *
 * Approves a draft or submitted PO (`ap/purchaseOrderApprove.approvePurchaseOrder`): the budget check on its
 * lines (month = order date), approved_by / approved_at stamped, the budget event and the audit rows. The PUT
 * no longer takes `status: 'approved'`. Roles: owner, admin, manager (withWriteAccess defaults).
 * Answers: 200 { ...purchase order, budgetWarnings? }; 400 not approvable / BUDGET_REASON_REQUIRED / bad body;
 * 403 Login-as session; 404 not this company's; 409 BUDGET_EXCEEDED (its refused event recorded, outside the
 * approval's savepoint); 429 past 120 a minute per user; 503 + Retry-After when the budget lock or the PO row is held.
 */
import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { respondIfBudgetRefused } from '@/lib/budgetCheckResponse';
import { checkRateLimit } from '@/lib/rateLimit';
import { isUuidParam } from '@/lib/validation';
import { BUDGET_REASON_MAX } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import {
  approvePurchaseOrder, PurchaseOrderNotApprovableError, PurchaseOrderNotFoundError,
} from '@/modules/accounting/services/ap/purchaseOrderApprove';

const ApproveSchema = z.object({
  budgetReason: z.string().trim().max(BUDGET_REASON_MAX).optional(),
  budgetOverride: z.boolean().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  // A refused approval writes an event and an audit row (a new reason each click escapes the 60 s dedupe):
  // 120 a minute per user, as supplier-invoices-action.
  if (!(await checkRateLimit(`purchase-order-approve:${req.user.id}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many purchase order approvals; wait a minute and try again.');
  }
  const id = req.query.id;
  if (typeof id !== 'string' || !isUuidParam(id)) return apiResponse.notFound(res, 'Purchase order');
  const parsed = ApproveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);

  try {
    const { budgetReason, budgetOverride } = parsed.data;
    const result = await approvePurchaseOrder(companyId, id, req.user.id, {
      channel: 'ui', lock: 'take', reason: budgetReason ?? null, override: budgetOverride === true, actorRole: companyRole,
    });
    return apiResponse.success(res, { ...result.purchaseOrder, ...(result.budgetWarnings ? { budgetWarnings: result.budgetWarnings } : {}) });
  } catch (err) {
    if (err instanceof PurchaseOrderNotFoundError) return apiResponse.notFound(res, 'Purchase order');
    if (err instanceof PurchaseOrderNotApprovableError) return apiResponse.badRequest(res, err.message);
    if (respondIfImpersonationForbidden(res, err)) return;
    if (await respondIfBudgetRefused(res, err)) return;
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
