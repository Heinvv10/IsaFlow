/**
 * Remaining budget preview (budgets P5 spec §4): for the approve dialog and the PO form.
 * POST { lines: [{ glAccountId, cc1Id?, cc2Id?, buId?, month: 'YYYY-MM' }], excludeInvoiceId?, excludePoItemIds? }
 *   → { lines: RemainingResult[] } in input order.
 * Each line: the primary version of the month's year, the account's grain and the slice the line
 * maps onto, budget (null = "No budget"; a budgeted zero is 0), posted actual, open PO commitment
 * and remaining (null with no budget). `excludeInvoiceId` is the bill being approved (its own
 * PO-linked lines count as billed); `excludePoItemIds` leaves PO lines out of committed.
 * Write roles only (owner, admin, manager): it previews an approval. Reads nothing but this company's
 * rows. 120 previews a minute per user (429 with Retry-After).
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { checkRateLimit } from '@/lib/rateLimit';
import { respondTrackingError } from '@/lib/budgetTrackingResponse';
import { mapRegistryMiss } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';

/** A document has at most a few hundred lines; a preview is one document. */
export const MAX_REMAINING_LINES = 200;

const RemainingSchema = z.object({
  lines: z.array(z.object({
    glAccountId: UUID,
    cc1Id: UUID.nullable().default(null),
    cc2Id: UUID.nullable().default(null),
    buId: UUID.nullable().default(null),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be 'YYYY-MM'"),
  })).min(1).max(MAX_REMAINING_LINES),
  excludeInvoiceId: UUID.nullable().optional(),
  excludePoItemIds: z.array(UUID).max(1000).optional(),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await checkRateLimit(`budget-remaining:${userId}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many budget previews; wait a minute and try again.');
  }
  const parsed = RemainingSchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { lines, excludeInvoiceId, excludePoItemIds } = parsed.data;
  try {
    const out = await mapRegistryMiss(() => remainingFor(companyId, lines, { excludeInvoiceId, excludePoItemIds }));
    return apiResponse.success(res, { lines: out });
  } catch (err) {
    if (respondTrackingError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
