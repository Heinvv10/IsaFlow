/**
 * One budget slice on the review board (budgets P5-6): its label, version, holders, due date (overdue
 * flagged), the last decision's note, and the moves the viewer may make: a holder submits an open or
 * returned slice; an owner or admin approves a submitted slice or returns it with a note (required).
 * An owner or admin may also remove a holder of an open or returned slice of a draft (Remove, then
 * Confirm); removing the last one removes the slice. The server decides; the buttons only follow the
 * same rules. A refusal stays on the card.
 */
import { useId, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { moveSlice, unassignHolder, type SliceAction, type SliceReview } from './reviewClient';

const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50';
const BTN_PRIMARY = `${BTN} bg-brand-600 text-white hover:bg-brand-700`;
const BTN_SECONDARY = `${BTN} border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)]`;

export interface SliceCardProps {
  slice: SliceReview;
  userId: string | null;
  reviewer: boolean;
  /** `YYYY-MM-DD` (SAST): the due date is compared with it. */
  today: string;
  onChanged: (s: SliceReview) => void;
  /** A holder was removed: the board reloads (the slice may be gone). */
  onRemoved: () => void;
}

export function SliceCard({ slice, userId, reviewer, today, onChanged, onRemoved }: SliceCardProps) {
  const [busy, setBusy] = useState<SliceAction | 'remove' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  const draft = slice.versionStatus === 'draft';
  const holder = userId !== null && slice.holders.some((h) => h.userId === userId);
  const canSubmit = draft && holder && (slice.status === 'open' || slice.status === 'returned');
  const canDecide = draft && reviewer && slice.status === 'submitted';
  const canRemove = draft && reviewer && (slice.status === 'open' || slice.status === 'returned');
  const overdue = slice.dueDate !== null && slice.dueDate < today && slice.status !== 'approved' && slice.status !== 'submitted';

  const run = async (action: SliceAction, text?: string) => {
    setBusy(action);
    setError(null);
    try {
      onChanged(await moveSlice(slice.id, action, text));
      setReturning(false);
      setNote('');
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (holderId: string) => {
    setBusy('remove');
    setError(null);
    try {
      await unassignHolder(holderId);
      setRemoving(null);
      onRemoved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not remove the holder. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li data-testid={`slice-${slice.id}`} className="space-y-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-[var(--ff-text-primary)]">{slice.label}</span>
        <span className={overdue ? 'text-error-700 dark:text-error-400' : 'text-[var(--ff-text-secondary)]'}>
          {slice.dueDate ? `${overdue ? 'Overdue: ' : 'Due '}${slice.dueDate}` : 'No due date'}
        </span>
      </div>
      <p className="text-[var(--ff-text-secondary)]">
        <Link href="/accounting/budgets" className="underline">{slice.versionName}</Link> · FY{slice.fiscalYear}
        {!draft && ` · version ${slice.versionStatus}`}
      </p>
      {!canRemove && (
        <p className="text-[var(--ff-text-secondary)]">
          Holder{slice.holders.length === 1 ? '' : 's'}: {slice.holders.length === 0 ? 'none' : slice.holders.map((h) => h.name ?? h.userId).join(', ')}
        </p>
      )}
      {canRemove && (
        <ul className="space-y-1 text-[var(--ff-text-secondary)]" aria-label="Holders">
          {slice.holders.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{h.name ?? h.userId}{h.glAccountIds ? ` (${h.glAccountIds.length} account${h.glAccountIds.length === 1 ? '' : 's'})` : ''}</span>
              {removing === h.id ? (
                <span className="flex gap-2">
                  <button type="button" className={BTN_SECONDARY} disabled={busy !== null} onClick={() => { void remove(h.id); }}
                    data-testid={`holder-remove-confirm-${h.id}`}>
                    {busy === 'remove' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Confirm remove
                  </button>
                  <button type="button" className={BTN_SECONDARY} disabled={busy !== null} onClick={() => setRemoving(null)}>Keep</button>
                </span>
              ) : (
                <button type="button" className={BTN_SECONDARY} disabled={busy !== null} onClick={() => setRemoving(h.id)}
                  aria-label={`Remove ${h.name ?? h.userId} as holder`} data-testid={`holder-remove-${h.id}`}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {slice.decisionNote && (
        <p className="rounded-md bg-[var(--ff-bg-tertiary)] p-2 text-[var(--ff-text-primary)]">
          {slice.status === 'returned' ? 'Returned: ' : 'Note: '}{slice.decisionNote}
        </p>
      )}
      {error && <p role="alert" className="text-error-700 dark:text-error-400">{error}</p>}
      {returning && (
        <div className="space-y-1">
          <label htmlFor={noteId} className="block font-medium text-[var(--ff-text-primary)]">What should change? (required)</label>
          <textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} disabled={busy !== null}
            className="w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-2 text-[var(--ff-text-primary)]" />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {canSubmit && (
          <button type="button" className={BTN_PRIMARY} disabled={busy !== null} onClick={() => { void run('submit'); }} data-testid="slice-submit">
            {busy === 'submit' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Submit for review
          </button>
        )}
        {canDecide && !returning && (
          <>
            <button type="button" className={BTN_PRIMARY} disabled={busy !== null} onClick={() => { void run('approve'); }} data-testid="slice-approve">
              {busy === 'approve' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Approve
            </button>
            <button type="button" className={BTN_SECONDARY} disabled={busy !== null} onClick={() => setReturning(true)} data-testid="slice-return">Return…</button>
          </>
        )}
        {canDecide && returning && (
          <>
            <button type="button" className={BTN_PRIMARY} disabled={busy !== null || note.trim() === ''} data-testid="slice-return-confirm"
              onClick={() => { void run('return', note.trim()); }}>
              {busy === 'return' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Return to holder
            </button>
            <button type="button" className={BTN_SECONDARY} disabled={busy !== null} onClick={() => { setReturning(false); setNote(''); }}>Cancel</button>
          </>
        )}
      </div>
    </li>
  );
}
