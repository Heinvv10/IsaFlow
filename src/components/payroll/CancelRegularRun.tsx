/**
 * "Cancel run" for a calculated regular run (wave 7 CX, W28): owner or admin. The run's calculation is released (loan
 * instalments, garnishee deductions, a pending approval request) and the run is removed, so its period is free for a new
 * run (payrollRunCancelRegular). The server refuses a run that was ever approved, posted, paid or declared and says why;
 * the refusal is shown here. Renders nothing for any other run or role.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { FocusedAlert } from '@/components/ui/FocusedAlert';

interface Props {
  runId: string;
  run: { runKind?: string; status: string };
  companyRole: string | null | undefined;
}

const FAILED = 'Could not cancel the pay run - try again';

export function CancelRegularRun({ runId, run, companyRole }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  if (run.runKind !== 'regular' || run.status !== 'calculated') return null;
  if (companyRole !== 'owner' && companyRole !== 'admin') return null;

  const cancel = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/cancel`, { method: 'POST' });
      await assertOk(res, FAILED);
      setOpen(false);
      await router.push('/payroll/runs');
    } catch (err) {
      setOpen(false);
      setError(apiErrorMessage(err, FAILED));
    } finally {
      setBusy(false);
    }
  };

  // Escape, Keep run or the backdrop: focus goes back to the button that opened the dialog.
  const close = () => {
    if (busy) return;
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <div className="space-y-2" data-testid="regular-run-cancel">
      <FocusedAlert message={error} />
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]">
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Calculated for the wrong period, or not paying it? Cancel it: nothing is paid and the period is free for a new run.
        </p>
        <button ref={trigger} type="button" onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-lg border border-red-400 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 text-sm font-medium">
          <XCircle className="h-4 w-4" aria-hidden="true" /> Cancel run
        </button>
      </div>
      <Modal open={open} onClose={close} title="Cancel this pay run?" size="sm">
        <Modal.Body>
          <div className="space-y-2 text-sm text-[var(--ff-text-secondary)]">
            <p>
              The run and its lines are removed. Loan instalments it took are given back to the loan balances, its garnishee
              deductions are dropped and a pending approval request is withdrawn. Nothing is paid, posted or declared.
            </p>
            <p>A run that was ever approved cannot be cancelled: reopen it instead.</p>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={close} disabled={busy}>Keep run</Button>
          <Button variant="danger" loading={busy} onClick={() => void cancel()}>Cancel this run</Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
