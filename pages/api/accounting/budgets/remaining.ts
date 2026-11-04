/**
 * Remaining budget preview (budgets P5 spec §4): for the approve dialog and the PO form.
 * POST { lines: [{ glAccountId, cc1Id?, cc2Id?, buId?, month: 'YYYY-MM' }], excludeInvoiceId?, excludePoItemIds? }
 *   → { lines: RemainingResult[] } in input order.
 * Each line: the primary version of the month's year, the account's grain and the slice the line
 * maps onto, budget (null = "No budget"; a budgeted zero is 0), posted actual, open PO commitment
 * and remaining (null with no budget). `excludeInvoiceId` is the bill being approved (its own
 * PO-linked lines count as billed); `excludePoItemIds` leaves PO lines out of committed.
 * Bounds (400 before anything is read): at most 200 lines, months 'YYYY-MM' in 1900-2200, spanning at
 * most 12 months first to last. Write roles only (owner, admin, manager): it previews an approval.
 * Reads nothing but this company's rows. 120 previews a minute per user (429 with Retry-After).
 *
 * Budgets P5-2, the bill approve dialogs (no locks: a preview; the approval decides again under its own):
 * POST { supplierInvoiceId } or { supplierInvoiceIds: [≤50] }: `@/lib/budgetBillPreview` (charged one unit per bill).
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
import { MAX_REMAINING_KEYS, remainingFor, remainingKeysProblem } from '@/modules/accounting/services/budgets/remainingBudget';
import { billPreviewCost, MAX_BULK_BILL_PREVIEW, respondBillPreview } from '@/lib/budgetBillPreview';

const RemainingSchema = z.object({
  lines: z.array(z.object({
    glAccountId: UUID,
    cc1Id: UUID.nullable().default(null),
    cc2Id: UUID.nullable().default(null),
    buId: UUID.nullable().default(null),
    month: z.string().max(7),
  })).max(MAX_REMAINING_KEYS),
  excludeInvoiceId: UUID.nullable().optional(),
  excludePoItemIds: z.array(UUID).max(1000).optional(),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  // The bulk bill mode's size first (400 before anything is charged or read); it is charged per bill.
  const ids = (req.body as { supplierInvoiceIds?: unknown } | undefined)?.supplierInvoiceIds;
  if (Array.isArray(ids) && ids.length > MAX_BULK_BILL_PREVIEW) {
    return apiResponse.badRequest(res, `At most ${MAX_BULK_BILL_PREVIEW} bills per budget preview`);
  }
  if (!(await checkRateLimit(`budget-remaining:${userId}`, { max: 120, windowSecs: 60, cost: billPreviewCost(req.body) }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many budget previews; wait a minute and try again.');
  }
  if (await respondBillPreview(companyId, req.body, res)) return;
  // The count first, before zod walks a long array (400, as every bound below).
  const raw = (req.body as { lines?: unknown } | undefined)?.lines;
  if (Array.isArray(raw) && raw.length > MAX_REMAINING_KEYS) {
    return apiResponse.badRequest(res, `At most ${MAX_REMAINING_KEYS} lines per preview`);
  }
  const parsed = RemainingSchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const { lines, excludeInvoiceId, excludePoItemIds } = parsed.data;
  // Month format, years YEAR_MIN..YEAR_MAX, at most MAX_REMAINING_MONTH_SPAN months: 400 before any read.
  const problem = remainingKeysProblem(lines.map((l) => l.month));
  if (problem) return apiResponse.badRequest(res, problem);
  try {
    const out = await mapRegistryMiss(() => remainingFor(companyId, lines, { excludeInvoiceId, excludePoItemIds }));
    return apiResponse.success(res, { lines: out });
  } catch (err) {
    if (respondTrackingError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
