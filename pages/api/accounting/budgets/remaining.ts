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
 * POST { supplierInvoiceId } → { policy, checks, lines: BudgetCheckLine[], overCount } — the lines approve
 *   would POST (`ap/supplierInvoiceBudgetCheck.previewBillBudget`), per budget slice, with this bill's amount.
 * POST { supplierInvoiceIds: [≤200] } → { policy, bills: [{ invoiceId, checks, overCount }], overBills } — the
 *   bulk approve modal's count. Each bill is judged on its own (a batch's bills also draw on each other).
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
import { previewBillBudget } from '@/modules/accounting/services/ap/supplierInvoiceBudgetCheck';
import { readCheckPolicy } from '@/modules/accounting/services/budgets/budgetCheck';
import { CostCentrePickRefusal } from '@/modules/accounting/services/gl/dimensions/costCentrePick';

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

const BillPreviewSchema = z.union([
  z.object({ supplierInvoiceId: UUID }).strict(),
  z.object({ supplierInvoiceIds: z.array(UUID).min(1).max(200) }).strict(),
]);

/** The bill modes (P5-2). Returns true when it answered. */
async function billPreview(companyId: string, body: unknown, res: NextApiResponse): Promise<boolean> {
  if (typeof body !== 'object' || body === null || !('supplierInvoiceId' in body || 'supplierInvoiceIds' in body)) return false;
  const parsed = BillPreviewSchema.safeParse(body);
  if (!parsed.success) { apiResponse.zodValidationError(res, parsed.error); return true; }
  try {
    if ('supplierInvoiceId' in parsed.data) {
      const preview = await mapRegistryMiss(() => previewBillBudget(companyId, (parsed.data as { supplierInvoiceId: string }).supplierInvoiceId));
      if (!preview) apiResponse.notFound(res, 'Supplier invoice');
      else apiResponse.success(res, preview);
      return true;
    }
    const bills = [];
    for (const invoiceId of [...new Set(parsed.data.supplierInvoiceIds)]) {
      const p = await mapRegistryMiss(() => previewBillBudget(companyId, invoiceId));
      if (p) bills.push({ invoiceId, checks: p.checks, overCount: p.overCount });
    }
    apiResponse.success(res, { policy: await readCheckPolicy(companyId), bills, overBills: bills.filter((b) => b.overCount > 0).length });
  } catch (err) {
    if (respondTrackingError(res, err)) return true;
    // A cost-centre pick approve itself would refuse (400 there too).
    if (err instanceof CostCentrePickRefusal) { apiResponse.badRequest(res, err.message); return true; }
    throw err;
  }
  return true;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (!(await checkRateLimit(`budget-remaining:${userId}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many budget previews; wait a minute and try again.');
  }
  if (await billPreview(companyId, req.body, res)) return;
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
