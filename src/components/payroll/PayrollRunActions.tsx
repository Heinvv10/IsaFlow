/**
 * PayrollRunActions — action buttons for a payroll run.
 * Renders Calculate / Approve / Pay / Cancel based on current status.
 */
import { Calculator, CheckCircle2, DollarSign, Loader2, XCircle } from 'lucide-react';

export interface PayrollRunActionsProps {
  status: string;
  isBusy: boolean;
  busyLabel: string;
  onCalculate: () => void;
  onApprove: () => void;
  onPay: () => void;
  onCancel: () => void;
}

export function PayrollRunActions({
  status,
  isBusy,
  busyLabel,
  onCalculate,
  onApprove,
  onPay,
  onCancel,
}: PayrollRunActionsProps) {
  const canCalculate = status === 'draft' || status === 'calculated';
  const canApprove   = status === 'calculated';
  const canPay       = status === 'approved';
  const canCancel    = status === 'draft' || status === 'calculated' || status === 'approved';

  const spinnerFor = (label: string) =>
    isBusy && busyLabel === label
      ? <Loader2 className="h-4 w-4 animate-spin" />
      : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {canCalculate && (
        <button
          onClick={onCalculate}
          disabled={isBusy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
        >
          {spinnerFor('calculating') ?? <Calculator className="h-4 w-4" />}
          {status === 'draft' ? 'Calculate' : 'Recalculate'}
        </button>
      )}

      {canApprove && (
        <button
          onClick={onApprove}
          disabled={isBusy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm font-medium"
        >
          {spinnerFor('approving') ?? <CheckCircle2 className="h-4 w-4" />}
          Approve
        </button>
      )}

      {canPay && (
        <button
          onClick={onPay}
          disabled={isBusy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium"
        >
          {spinnerFor('paying') ?? <DollarSign className="h-4 w-4" />}
          Pay
        </button>
      )}

      {canCancel && (
        <button
          onClick={onCancel}
          disabled={isBusy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium"
        >
          {spinnerFor('cancelling') ?? <XCircle className="h-4 w-4" />}
          Cancel
        </button>
      )}
    </div>
  );
}
