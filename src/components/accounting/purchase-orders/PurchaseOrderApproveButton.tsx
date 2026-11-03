/**
 * The purchase order's Approve action (budgets P5-3, spec §5): replaces the status select's "Approved" option.
 * Previews the PO's budget (POST /api/accounting/budgets/remaining { purchaseOrderId }); when a line meets a budget
 * the bills' approve dialog opens (`BudgetApproveDialog`, worded for an order: per-slice remaining, reason when over
 * in warn, owner/admin override in block), otherwise it approves at once
 * (POST /api/accounting/purchase-orders/[id]/approve). A line with no account is listed as "No account", no budget.
 */
import { CheckCircle, Loader2 } from 'lucide-react';
import { BudgetApproveDialog } from '@/components/accounting/ap/BudgetApproveDialog';
import { useBudgetApprove } from '@/components/accounting/ap/useBudgetApprove';

interface Props {
  poId: string;
  /** After a successful approval (the route's JSON). */
  onApproved: (json: unknown) => Promise<void> | void;
  /** A refusal that is not the budget's, for the page to show. */
  onError: (message: string) => void;
  /** Reload the PO (a 409 that is not the budget's). */
  onReload: () => Promise<void>;
}

export function PurchaseOrderApproveButton({ poId, onApproved, onError, onReload }: Props) {
  const approve = useBudgetApprove(poId, onApproved, onError, onReload, 'purchase_order');
  return (
    <>
      <button type="button" onClick={() => void approve.start()} disabled={approve.busy}
        className="inline-flex items-center gap-2 px-4 py-2 bg-success-700 hover:bg-success-800 text-white rounded-lg text-sm font-medium disabled:opacity-50">
        {approve.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
        {approve.busy ? 'Approving…' : 'Approve'}
      </button>
      {approve.dialog.open && <BudgetApproveDialog {...approve.dialog} />}
    </>
  );
}
