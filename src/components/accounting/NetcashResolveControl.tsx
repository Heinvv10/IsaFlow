import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';

/** The roles `POST /api/accounting/netcash/resolve` accepts. */
const RESOLVE_ROLES = ['owner', 'admin'];

type Outcome = 'failed' | 'submitted';

/** status.ts keeps the last Netcash poll on the row (netcash_response.latestPoll): context for the operator only. */
export interface LastPoll { status?: string; at?: string }

/** Statuses resolve accepts: every row that holds its batch. A completed or failed row is never resolved. */
const RESOLVABLE = ['pending', 'unknown', 'submitted', 'processing'];
/** Netcash accepted these: freeing one can pay the batch twice, so it is offered as "failed" only, with a warning. */
const accepted = (status: string) => status === 'submitted' || status === 'processing';

/** Whether `role` may resolve a submission in this state (owner/admin; pending, unknown, submitted or processing). */
export function canResolveSubmission(role: string | null | undefined, status: string): boolean {
  return RESOLVE_ROLES.includes(role ?? '') && RESOLVABLE.includes(status);
}

function lastPollText(poll: LastPoll | null | undefined): string {
  if (!poll?.status) return 'Netcash has not been checked from here yet.';
  const when = poll.at ? new Date(poll.at).toLocaleString('en-ZA') : '';
  return `Last Netcash check${when ? ` (${when})` : ''}: "${poll.status}". This is context only - check the Netcash portal.`;
}

/**
 * The inline resolve form (netcash/resolve): what Netcash shows, a required note typed here, Confirm / Cancel. A
 * pending/unknown claim offers both outcomes. A submitted/processing row offers "failed" only, warns that freeing it
 * can pay the batch twice, and shows the last poll's answer as context (never as the reason it may be freed). The
 * page puts it in a full-width row under the submission so it never squeezes the table's columns.
 */
export function NetcashResolveForm({ submissionId, status, lastPoll, onResolved, onClose }: {
  submissionId: string; status: string; lastPoll: LastPoll | null | undefined; onResolved: () => void; onClose: () => void;
}) {
  const wasAccepted = accepted(status);
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
      {wasAccepted && (
        <div className="space-y-1 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-red-400">
          <p className="font-medium">
            Netcash accepted this batch. Freeing it lets the batch be sent again: if Netcash has it, the suppliers are paid twice.
            Only continue once the Netcash portal shows it was rejected or never processed.
          </p>
          <p className="text-[var(--ff-text-secondary)]">{lastPollText(lastPoll)}</p>
        </div>
      )}
      <fieldset className="space-y-1">
        <legend className="mb-1 font-medium text-[var(--ff-text-primary)]">What does Netcash show?</legend>
        <label className="flex items-start gap-2 text-[var(--ff-text-secondary)]">
          <input type="radio" name={`outcome-${submissionId}`} checked={outcome === 'failed'} onChange={() => setOutcome('failed')} className="mt-0.5" />
          <span>{wasAccepted
            ? 'Netcash rejected it or never processed it - allow it to be sent again'
            : 'Netcash never received this batch - allow it to be sent again'}</span>
        </label>
        {!wasAccepted && (
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
