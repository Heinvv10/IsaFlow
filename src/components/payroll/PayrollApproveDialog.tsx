/**
 * PayrollApproveDialog — "Review & approve" confirmation for a pay run (PAY-01).
 *
 * Shows what approval will do, exactly as the server's approval gate judged it
 * (GET …/journal-plan): the journal it will post, or — for a reopened run —
 * the journal it already posted and will re-lock onto, or that the reversed
 * one is being replaced. No amount is derived
 * here. A blocker disables approval with its reason.
 *
 * The POST carries the planHash previewed; a run changed since answers 409.
 * Any 4xx is a refusal (nothing written), and the preview is refetched after
 * every one, so the dialog never keeps showing a plan the server just
 * rejected. Anything
 * else — a dropped connection, a proxy 5xx — may have committed, so the page
 * reloads the run instead of guessing.
 */
import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { apiJson, apiErrorMessage, ApiRequestError } from '@/lib/apiFetch';
import type { ResponseFor } from '@/lib/apiRoutes';
import { formatCurrency } from '@/utils/formatters';

type Preview = ResponseFor<'/api/payroll/runs/{}/journal-plan'>;
export type ApproveResult = ResponseFor<'/api/payroll/runs/{}/approve'>;

interface Props {
  runId: string;
  period: string;
  warningCount: number;
  open: boolean;
  onClose: () => void;
  /** `newJournal` is false when approval re-locked the run onto the journal it already carried. */
  onApproved: (result: ApproveResult, newJournal: boolean) => void;
  /** Approval's outcome is unknown (transport failure): the page must reload the run. */
  onUncertain: () => void;
}

const money = (n: number) => (n === 0 ? '' : formatCurrency(n));
const UNCERTAIN = 'The approval could not be confirmed. The run has been reloaded — check its status before approving again.';

export function PayrollApproveDialog({ runId, period, warningCount, open, onClose, onApproved, onUncertain }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [approveError, setApproveError] = useState('');
  const [approving, setApproving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setLoadError('');
    apiJson(`/api/payroll/runs/${runId}/journal-plan`)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err: unknown) => { if (!cancelled) setLoadError(apiErrorMessage(err, 'Could not load the journal this run would post')); });
    return () => { cancelled = true; };
  }, [open, runId, reloadKey]);

  useEffect(() => { if (open) setApproveError(''); }, [open]);

  const approve = async () => {
    if (!preview) return;
    setApproving(true);
    setApproveError('');
    try {
      const result = await apiJson(`/api/payroll/runs/${runId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ expectedPlanHash: preview.planHash }),
      });
      onApproved(result, !preview.posted);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status < 500) {
        setApproveError(err.status === 409 ? `${err.message}. The preview has been refreshed — review it again.` : err.message);
        setReloadKey((k) => k + 1);
      } else {
        setApproveError(UNCERTAIN);
        onUncertain();
      }
    } finally {
      setApproving(false);
    }
  };

  const plan = preview?.plan;
  const posted = preview?.posted ?? null;
  const replaces = preview?.replaces ?? null;
  const blocker = preview?.blocker ?? null;
  const shown = posted && !blocker ? posted : plan;
  const canApprove = !!preview && !blocker && !approving;

  return (
    <Modal open={open} onClose={onClose} title={`Approve payroll — ${period}`} size="lg">
      <Modal.Body className="space-y-4 text-sm">
        {!preview && !loadError && (
          <div className="flex items-center gap-2 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading the journal…</div>
        )}
        {loadError && <p className="text-red-500">{loadError}</p>}
        {plan && shown && (
          <>
            {!blocker && (
              <p className="text-gray-600 dark:text-gray-300">
                {posted
                  ? <>Already posted: journal <span className="font-mono">{posted.entryNumber}</span>. Approving locks this run again and posts nothing new.</>
                  : <>Approving locks this run and posts journal <span className="font-mono">{plan.reference}</span> dated {plan.entryDate} for {plan.employeeCount} employee{plan.employeeCount === 1 ? '' : 's'}:</>}
              </p>
            )}
            {!blocker && replaces && (
              <p className="text-gray-600 dark:text-gray-300">
                The journal this run posted before (<span className="font-mono">{replaces.entryNumber}</span>) was reversed, so a new one is posted in its place.
              </p>
            )}
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1">{posted && !blocker ? 'Account (already posted)' : 'Account'}</th>
                  <th className="py-1 text-right">Debit</th><th className="py-1 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {shown.lines.map((l, i) => (
                  <tr key={`${l.accountCode}-${i}`} className="border-t border-gray-200 dark:border-white/10">
                    <td className="py-1"><span className="font-mono mr-2">{l.accountCode}</span>{l.accountName}</td>
                    <td className="py-1 text-right font-mono">{money(l.debit)}</td>
                    <td className="py-1 text-right font-mono">{money(l.credit)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-gray-300 dark:border-white/20 font-semibold">
                  <td className="py-1">Total</td>
                  <td className="py-1 text-right font-mono">{formatCurrency(shown.totalDebit)}</td>
                  <td className="py-1 text-right font-mono">{formatCurrency(shown.totalCredit)}</td>
                </tr>
              </tbody>
            </table>
            {!posted && plan.advisories.map((a) => (
              <p key={a.code} className="flex gap-2 text-amber-600 dark:text-amber-400"><AlertTriangle className="h-4 w-4 shrink-0" />{a.detail}</p>
            ))}
            {warningCount > 0 && (
              <p className="flex gap-2 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {warningCount} warning{warningCount === 1 ? '' : 's'} on this run (listed on the page). They do not block approval.
              </p>
            )}
            {blocker && (
              <p className="flex gap-2 text-red-500"><AlertCircle className="h-4 w-4 shrink-0" />{blocker.detail}</p>
            )}
          </>
        )}
        {approveError && <p role="alert" className="flex gap-2 text-red-500"><AlertCircle className="h-4 w-4 shrink-0" />{approveError}</p>}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 dark:border-white/20 text-sm">Cancel</button>
        <button type="button" onClick={approve} disabled={!canApprove}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium">
          {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {posted && !blocker ? 'Approve (no new journal)' : 'Approve and post journal'}
        </button>
      </Modal.Footer>
    </Modal>
  );
}
