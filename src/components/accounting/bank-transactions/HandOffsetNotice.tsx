/**
 * R-079 — a line the auto-post undo refused because a manual journal already
 * offsets its posting. Reversing it too would apply the correction twice, so
 * the user either reverses their journal and undoes again, or confirms that
 * journal IS the correction. Confirming posts nothing; it is recorded under
 * the user's name. It goes through a confirm dialog, never one click.
 */

import { useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export interface HandOffset {
  transactionId: string;
  journalEntryId: string;
  entryNumber: string;
}

interface Props {
  runId: string;
  offset: HandOffset;
  /** Called once the confirmation is recorded; `runClosed` when it was the run's last line. */
  onConfirmed: (offset: HandOffset, runClosed: boolean) => void;
}

export function HandOffsetNotice({ runId, offset, onConfirmed }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/bank-auto-post', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'confirmHandCorrection',
          runId,
          transactionId: offset.transactionId,
          offsetJournalId: offset.journalEntryId,
        }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(errJson.error?.message ?? `Confirmation failed (${res.status})`);
      }
      const result = ((await res.json()) as { data?: { runClosed?: boolean } }).data;
      setOpen(false);
      onConfirmed(offset, result?.runClosed === true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed — please try again');
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="text-xs text-amber-500">
      <span>
        {offset.entryNumber} already offsets this posting — reverse that journal instead, or confirm it is
        the correction.
      </span>{' '}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-blue-500 hover:underline"
      >
        Confirm {offset.entryNumber} is the correction
      </button>
      {error && <p className="text-red-400 mt-1">{error}</p>}
      <ConfirmDialog
        open={open}
        title="Confirm the hand correction"
        message={
          <>
            Treat <strong>{offset.entryNumber}</strong> as the correction of this auto-posted line. Nothing will be
            posted or reversed: the books stay as they are now, the line leaves this run, and the confirmation is
            recorded under your name.
          </>
        }
        acceptLabel={`Confirm ${offset.entryNumber}`}
        loading={saving}
        onAccept={() => { void confirm(); }}
        onCancel={() => setOpen(false)}
      />
    </li>
  );
}
