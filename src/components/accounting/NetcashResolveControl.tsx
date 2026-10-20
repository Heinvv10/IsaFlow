import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';

/** The roles `POST /api/accounting/netcash/resolve` accepts. */
const RESOLVE_ROLES = ['owner', 'admin'];

type Outcome = 'failed' | 'submitted';

interface Props {
  submissionId: string;
  status: string;
  /** Netcash's latest poll of a submitted/processing row reported a failure (netcash_response.pollFailure). */
  pollFailed: boolean;
  onResolved: () => void;
}

/**
 * Whether `role` may resolve a submission in this state: owner/admin, and only a pending or unknown claim, or a
 * submitted/processing one whose latest poll reported a failure (a polled-failed row is freed as "failed" only).
 */
export function canResolveSubmission(role: string | null | undefined, status: string, pollFailed: boolean): boolean {
  if (!RESOLVE_ROLES.includes(role ?? '')) return false;
  return status === 'pending' || status === 'unknown' || ((status === 'submitted' || status === 'processing') && pollFailed);
}

/**
 * The inline resolve form (netcash/resolve): what Netcash shows, a required note typed here, Confirm / Cancel. A
 * polled-failed row (`polledFailed`) is offered "never received" only. The page puts it in a full-width row under the
 * submission so it never squeezes the table's columns.
 */
export function NetcashResolveForm({ submissionId, polledFailed, onResolved, onClose }: {
  submissionId: string; polledFailed: boolean; onResolved: () => void; onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    if (!outcome) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/netcash/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId, outcome, note: note.trim() }),
      });
      await assertOk(res, 'Could not resolve the submission - try again');
      onClose();
      onResolved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not resolve the submission - try again'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl space-y-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-3 text-left text-xs">
      <fieldset className="space-y-1">
        <legend className="mb-1 font-medium text-[var(--ff-text-primary)]">What does Netcash show?</legend>
        <label className="flex items-start gap-2 text-[var(--ff-text-secondary)]">
          <input type="radio" name={`outcome-${submissionId}`} checked={outcome === 'failed'} onChange={() => setOutcome('failed')} className="mt-0.5" />
          <span>Netcash never received this batch - allow it to be sent again</span>
        </label>
        {!polledFailed && (
          <label className="flex items-start gap-2 text-[var(--ff-text-secondary)]">
            <input type="radio" name={`outcome-${submissionId}`} checked={outcome === 'submitted'} onChange={() => setOutcome('submitted')} className="mt-0.5" />
            <span>Netcash has this batch - keep it closed</span>
          </label>
        )}
      </fieldset>
      <label className="block text-[var(--ff-text-secondary)]">
        What did you find at Netcash?
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          className="mt-1 w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] px-2 py-1 text-sm text-[var(--ff-text-primary)]"
        />
      </label>
      {error && <p className="text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} disabled={busy} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
          Cancel
        </button>
        <button
          onClick={() => void confirm()}
          disabled={busy || !outcome || note.trim() === ''}
          className="flex items-center gap-1 rounded-md bg-orange-600 px-2.5 py-1 font-medium text-white hover:bg-orange-500 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          Confirm
        </button>
      </div>
    </div>
  );
}

/** Button and form together, for a place that has no table row to put the form in. Renders nothing when not allowed. */
export function NetcashResolveControl({ submissionId, status, pollFailed, onResolved }: Props) {
  const role = useCompany().companyRole;
  const [open, setOpen] = useState(false);
  if (!canResolveSubmission(role, status, pollFailed)) return null;
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-orange-400 hover:text-orange-300">
        Resolve…
      </button>
    );
  }
  return <NetcashResolveForm submissionId={submissionId} polledFailed={pollFailed && status !== 'pending' && status !== 'unknown'} onResolved={onResolved} onClose={() => setOpen(false)} />;
}
