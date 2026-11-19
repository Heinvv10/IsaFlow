/**
 * "Cancel run" for an off-cycle run that is not final (wave 6 OC, UI review #1620 H): owner or admin, draft or
 * calculated. The run is set to cancelled and its employees are free for another off-cycle run of the month
 * (payrollOffCycleCancel). Renders nothing for any other run or role.
 */
import { useState } from 'react';
import { XCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { FocusedAlert } from './FocusedAlert';

interface Props {
  runId: string;
  run: { runKind?: string; status: string };
  companyRole: string | null | undefined;
  onCancelled: () => void;
}

export function CancelOffCycleRun({ runId, run, companyRole, onCancelled }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (run.runKind !== 'off_cycle' || (run.status !== 'draft' && run.status !== 'calculated')) return null;
  if (companyRole !== 'owner' && companyRole !== 'admin') return null;

  const cancel = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/cancel`, { method: 'POST' });
      await assertOk(res, 'Could not cancel the off-cycle run - try again');
      setOpen(false);
      onCancelled();
    } catch (err) {
      setOpen(false);
      setError(apiErrorMessage(err, 'Could not cancel the off-cycle run - try again'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <FocusedAlert message={error} />
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]">
        <p className="text-sm text-[var(--ff-text-secondary)]">Not needed, or its pay date has passed? Cancel it: nothing is paid and its employees are free for another off-cycle run.</p>
        <button type="button" onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-lg border border-red-400 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium">
          <XCircle className="h-4 w-4" aria-hidden="true" /> Cancel run
        </button>
      </div>
      <ConfirmDialog open={open} title="Cancel this off-cycle run?" tone="destructive" loading={busy}
        message="The run is cancelled and its lines are removed. Nothing is paid, posted or declared, and its employees can be put on another off-cycle run of the month."
        acceptLabel="Cancel run" cancelLabel="Keep run" onAccept={() => void cancel()} onCancel={() => setOpen(false)} />
    </div>
  );
}
