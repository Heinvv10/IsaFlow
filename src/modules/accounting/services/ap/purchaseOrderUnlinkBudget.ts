/**
 * What an unlink should tell the caller about the budget (Hein's ruling R2, 19 Nov): the purchase order commits spend again
 * (it reopened, or its lines are no longer netted by a bill) and may now be over budget. A READ: `previewPurchaseOrderBudget`
 * evaluates the PO's lines at their open amounts exactly as the Approve dialog does, and records nothing (no
 * budget_check_events row, no `approve` audit row). Never throws a budget refusal, whatever the policy: the unlink is done.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { previewPurchaseOrderBudget } from './purchaseOrderBudget';

export async function unlinkBudgetWarnings(companyId: string, poId: string, poNumber: string, figures: boolean): Promise<string[]> {
  const preview = await previewPurchaseOrderBudget(companyId, poId);
  if (!preview || !preview.checks) return [];
  return preview.lines.filter((l) => l.over || l.offSlice).map((l) => {
    const where = [l.accountLabel, l.sliceLabel, l.month].filter((s) => s !== '').join(' · ');
    const by = l.over && figures && l.remaining !== null ? ` by ${formatMoney(Math.max(0, l.amount - l.remaining))}` : '';
    return l.offSlice
      ? `Unlinked. Purchase order ${poNumber} commits spend again outside the budgeted slices (${where}).`
      : `Unlinked. Purchase order ${poNumber} commits spend again and is now over budget on ${where}${by}.`;
  });
}
