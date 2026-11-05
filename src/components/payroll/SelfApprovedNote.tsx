/**
 * Shown on an approved pay run whose approval was decided by the person who raised it (the sole-approver
 * fallback: nobody else in the company could approve). Visible to everyone who can open the run.
 */
import { AlertTriangle } from 'lucide-react';
import type { PayRunDecisionSummary } from '@/modules/accounting/types/payRunDecision.types';

export function SelfApprovedNote({ decision }: { decision: PayRunDecisionSummary | null | undefined }) {
  if (!decision?.selfApprovedSoleApprover) return null;
  return (
    <div role="status" data-testid="self-approved-note"
      className="flex items-start gap-2 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-sm">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <span>
        Approved by the person who requested the approval, because no one else in the company could approve it
        (sole-approver exception).{decision.preparedByDecider ? ' The same person also calculated this run.' : ''}
      </span>
    </div>
  );
}
