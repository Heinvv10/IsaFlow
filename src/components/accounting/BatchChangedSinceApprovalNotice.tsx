import { AlertTriangle, Check, Loader2 } from 'lucide-react';

/**
 * An approved (or processed) batch whose content - a payee, their name or bank details, an amount, or the
 * paying account - changed after it was approved (migrations 922, 923). The bank file, the Netcash send and
 * processing refuse it (409 BATCH_CHANGED_SINCE_APPROVAL) until someone re-approves what it now pays. The button
 * calls the batch's own approve action; under approval enforcement that still needs a cleared approval request
 * (the panel below).
 */
export function BatchChangedSinceApprovalNotice({ busy, disabled, onReapprove }: {
  busy: boolean; disabled: boolean; onReapprove: () => void;
}) {
  return (
    <div role="alert" data-testid="batch-changed-since-approval"
      className="mx-6 mt-4 flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10">
      <div className="flex items-start gap-2 text-sm text-amber-300">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          <strong>Content changed since approval — re-approve.</strong> A payee, their name or bank details, an
          amount or the paying account changed after this batch was approved, so it cannot be sent to the bank or
          processed until it is approved again.
          Check the payments below first.
        </span>
      </div>
      <button onClick={onReapprove} disabled={disabled}
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Re-approve
      </button>
    </div>
  );
}
