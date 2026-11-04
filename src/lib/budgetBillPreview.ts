/**
 * The bill modes of POST /api/accounting/budgets/remaining (budgets P5-2), for the approve dialogs.
 * No locks: a preview; the approval decides again under its own.
 * - { supplierInvoiceId } → { policy, checks, lines: BudgetCheckLine[], overCount }: the lines approve would
 *   post (`previewBillBudget`), per budget slice, with this bill's amount. 404 for a bill not this company's;
 *   400 for a cost-centre pick approve would refuse.
 * - { supplierInvoiceIds: [1..MAX_BULK_BILL_PREVIEW] } → { policy, bills: [{ invoiceId, checks, overCount }
 *   | { invoiceId, unavailable }], overBills }: the bulk modal's count, each bill judged on its own. A bill
 *   not this company's is left out; one whose budget cannot be read (a refusal approve would give) is reported
 *   `unavailable` with that refusal and the rest still answer (each in its own savepoint). A driver error is
 *   not a refusal and is re-thrown. The policy is read once per request.
 * The route charges its rate limit by the number of bills (`billPreviewCost`).
 */
import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withSavepoint } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { UUID } from '@/lib/schemas/common';
import { isCallerSafeError } from '@/lib/lockTimeout';
import { respondTrackingError } from '@/lib/budgetTrackingResponse';
import { mapRegistryMiss } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { previewBillBudget } from '@/modules/accounting/services/ap/supplierInvoiceBudgetCheck';
import { readCheckPolicy } from '@/modules/accounting/services/budgets/budgetCheck';
import { CostCentrePickRefusal } from '@/modules/accounting/services/gl/dimensions/costCentrePick';

export const MAX_BULK_BILL_PREVIEW = 50;

const BillPreviewSchema = z.union([
  z.object({ supplierInvoiceId: UUID }).strict(),
  z.object({ supplierInvoiceIds: z.array(UUID).min(1).max(MAX_BULK_BILL_PREVIEW) }).strict(),
]);

const isBillMode = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && ('supplierInvoiceId' in body || 'supplierInvoiceIds' in body);

/** Rate-limit units for a request: one per bill in the bulk mode (at least 1). */
export function billPreviewCost(body: unknown): number {
  const ids = isBillMode(body) ? body.supplierInvoiceIds : undefined;
  return Array.isArray(ids) ? Math.max(1, Math.min(ids.length, MAX_BULK_BILL_PREVIEW)) : 1;
}

/** A refusal approve would also give: reported for that bill, never a 500 for the whole preview. */
const isPreviewRefusal = (err: unknown): err is Error =>
  err instanceof CostCentrePickRefusal || err instanceof TrackingError || isCallerSafeError(err);

/** Answers a bill-mode body; false when the body is not one (the key mode handles it). */
export async function respondBillPreview(companyId: string, body: unknown, res: NextApiResponse): Promise<boolean> {
  if (!isBillMode(body)) return false;
  const parsed = BillPreviewSchema.safeParse(body);
  if (!parsed.success) { apiResponse.zodValidationError(res, parsed.error); return true; }
  const data = parsed.data;
  if ('supplierInvoiceId' in data) {
    try {
      const preview = await mapRegistryMiss(() => previewBillBudget(companyId, data.supplierInvoiceId));
      if (!preview) apiResponse.notFound(res, 'Supplier invoice');
      else apiResponse.success(res, preview);
    } catch (err) {
      if (respondTrackingError(res, err)) return true;
      if (err instanceof CostCentrePickRefusal) { apiResponse.badRequest(res, err.message); return true; }
      throw err;
    }
    return true;
  }
  const policy = await readCheckPolicy(companyId);
  const bills: Array<{ invoiceId: string; checks: boolean; overCount: number } | { invoiceId: string; unavailable: string }> = [];
  for (const invoiceId of [...new Set(data.supplierInvoiceIds)]) {
    try {
      const p = await withSavepoint('bill_budget_preview', () => mapRegistryMiss(() => previewBillBudget(companyId, invoiceId, { policy })));
      if (p) bills.push({ invoiceId, checks: p.checks, overCount: p.overCount });
    } catch (err) {
      if (!isPreviewRefusal(err)) throw err;
      bills.push({ invoiceId, unavailable: err.message });
    }
  }
  const overBills = bills.filter((b) => 'overCount' in b && b.overCount > 0).length;
  apiResponse.success(res, { policy, bills, overBills });
  return true;
}
