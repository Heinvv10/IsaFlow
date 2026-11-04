/**
 * The purchase-order mode of POST /api/accounting/budgets/remaining (budgets P5-3), for the PO approve dialog.
 * No locks: a preview; the approval decides again under its own.
 * { purchaseOrderId } → { policy, checks, status, approvable, lines: BudgetCheckLine[], overCount }: the PO's
 * lines per budget slice (`previewPurchaseOrderBudget`: month = order date, its own commitment excluded, a line
 * with no account listed as "No account" with no budget). 404 for a PO not this company's. One rate-limit unit.
 */
import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { UUID } from '@/lib/schemas/common';
import { respondTrackingError } from '@/lib/budgetTrackingResponse';
import { mapRegistryMiss } from '@/modules/accounting/services/budgets/tracking/trackingWindow';
import { previewPurchaseOrderBudget } from '@/modules/accounting/services/ap/purchaseOrderBudget';

const PoPreviewSchema = z.object({ purchaseOrderId: UUID }).strict();

const isPoMode = (body: unknown): boolean => typeof body === 'object' && body !== null && 'purchaseOrderId' in body;

/** Answers a PO-mode body; false when the body is not one. */
export async function respondPoPreview(companyId: string, body: unknown, res: NextApiResponse): Promise<boolean> {
  if (!isPoMode(body)) return false;
  const parsed = PoPreviewSchema.safeParse(body);
  if (!parsed.success) { apiResponse.zodValidationError(res, parsed.error); return true; }
  try {
    const preview = await mapRegistryMiss(() => previewPurchaseOrderBudget(companyId, parsed.data.purchaseOrderId));
    if (!preview) apiResponse.notFound(res, 'Purchase order');
    else apiResponse.success(res, preview);
  } catch (err) {
    if (respondTrackingError(res, err)) return true;
    throw err;
  }
  return true;
}
