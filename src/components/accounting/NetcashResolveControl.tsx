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
 * Releases a Netcash submission that holds its batch, once Netcash has been checked (netcash/resolve): a pending or
 * unknown claim either way, a submitted/processing one only as "failed" and only while its last poll reported a
 * failure. Owner/admin only; the note is required and typed inline. Renders nothing for anyone or anything else.
 */
export function NetcashResolveControl({ submissionId, status, pollFailed, onResolved }: Props) {
  const canResolve = RESOLVE_ROLES.includes(useCompany().companyRole ?? '');
  const heldOpen = status === 'pending' || status === 'unknown';
  const polledFailed = (status === 'submitted' || status === 'processing') && pollFailed;
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!canResolve || !(heldOpen || polledFailed)) return null;

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
      setOpen(false);
      setOutcome('');
      setNote('');
      onResolved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not resolve the submission - try again'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-orange-400 hover:text-orange-300">
        Resolve…
      </button>
    );
  }

  return (
    <div className="w-72 space-y-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-3 text-left text-xs">
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
        <button onClick={() => { setOpen(false); setError(''); }} disabled={busy} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
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
