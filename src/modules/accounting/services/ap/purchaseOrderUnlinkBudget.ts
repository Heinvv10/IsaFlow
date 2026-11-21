/**
 * What an unlink should tell the caller about the budget (Hein's ruling R2, 19 Nov): the purchase order commits spend again
 * (it reopened, or its lines are no longer netted by a bill) and may now be over budget. A READ: `previewPurchaseOrderBudget`
 * evaluates the PO's lines at their open amounts exactly as the Approve dialog does, and records nothing (no
 * budget_check_events row, no `approve` audit row). Never throws a budget refusal, whatever the policy: the unlink is done.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { previewPurchaseOrderBudget } from './purchaseOrderBudget';

/** The warnings, and the structured flags a screen reads instead of the prose (Codex gate review L11). */
export async function unlinkBudgetRead(companyId: string, poId: string, poNumber: string, figures: boolean, lead = 'Unlinked.'):
  Promise<{ warnings: string[]; overBudget: boolean; outsideSlices: boolean }> {
  const preview = await previewPurchaseOrderBudget(companyId, poId);
  if (!preview || !preview.checks) return { warnings: [], overBudget: false, outsideSlices: false };
  const flagged = preview.lines.filter((l) => l.over || l.offSlice);
  return {
    warnings: budgetLines(flagged, poNumber, figures, lead),
    overBudget: flagged.some((l) => l.over && !l.offSlice), outsideSlices: flagged.some((l) => l.offSlice),
  };
}

export async function unlinkBudgetWarnings(companyId: string, poId: string, poNumber: string, figures: boolean, lead = 'Unlinked.'): Promise<string[]> {
  return (await unlinkBudgetRead(companyId, poId, poNumber, figures, lead)).warnings;
}

type FlaggedLine = NonNullable<Awaited<ReturnType<typeof previewPurchaseOrderBudget>>>['lines'][number];
function budgetLines(flagged: FlaggedLine[], poNumber: string, figures: boolean, lead: string): string[] {
  return flagged.map((l) => {
    const where = [l.accountLabel, l.sliceLabel, l.month].filter((s) => s !== '').join(' · ');
    const by = l.over && figures && l.remaining !== null ? ` by ${formatMoney(Math.max(0, l.amount - l.remaining))}` : '';
    return l.offSlice
      ? `${lead} Purchase order ${poNumber} commits spend again outside the budgeted slices (${where}).`
      : `${lead} Purchase order ${poNumber} commits spend again and is now over budget on ${where}${by}.`;
  });
}

/** The same read for the PO a link took header rands from (PR #1703 breaker R4-4): its committed rose. */
export const linkHeaderBudgetWarnings = (companyId: string, poId: string, poNumber: string, figures: boolean): Promise<string[]> =>
  unlinkBudgetWarnings(companyId, poId, poNumber, figures, 'Linked.');
