/**
 * R-079 — a line the auto-post undo refused because a later journal may
 * already correct its posting. Reversing the posting too would apply a hand
 * correction twice, so the user decides: reverse their journal and undo again,
 * mark it as the correction (posts nothing), or declare it unrelated and undo
 * the line anyway. Both recorded decisions sit behind their own confirm dialog,
 * never one click, and name the line and the journal so two refused lines that
 * share one journal can be told apart.
 */

import { useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export interface HandOffset {
  transactionId: string;
  lineDate: string;
  lineAmount: number;
  lineDescription: string;
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  amount: number;
  description: string;
}

type Decision = 'confirmHandCorrection' | 'undoAnyway';

interface Props {
  runId: string;
  offset: HandOffset;
  /**
   * Called once a decision is recorded; `runClosed` when the run is now undone,
   * `next` when another journal still blocks the same line.
   */
  onDecided: (offset: HandOffset, runClosed: boolean, next: HandOffset | null) => void;
}

const rands = (n: number) =>
  `${n < 0 ? '−' : ''}R${Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DIALOG: Record<Decision, { title: string; accept: (o: HandOffset) => string; body: (o: HandOffset) => string }> = {
  confirmHandCorrection: {
    title: 'Mark as corrected by hand',
    accept: (o) => `Mark ${o.entryNumber} as the correction`,
    body: (o) => `Treat ${o.entryNumber} as the correction of this auto-posted line. Nothing will be posted or `
      + 'reversed: the books stay as they are now, the line leaves this run, and the decision is recorded under your name.',
  },
  undoAnyway: {
    title: 'Not the correction — undo anyway',
    accept: () => 'Undo the line anyway',
    body: (o) => `${o.entryNumber} is unrelated to this line. The auto-posting will be reversed and ${o.entryNumber} `
      + 'stays on the books on its own. The decision is recorded under your name.',
  },
};

export function HandOffsetNotice({ runId, offset, onDecided }: Props) {
  const [open, setOpen] = useState<Decision | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: Decision) {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/bank-auto-post', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action, runId, transactionId: offset.transactionId, offsetJournalId: offset.journalEntryId,
        }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(errJson.error?.message ?? `The decision was not recorded (${res.status})`);
      }
      const result = ((await res.json()) as { data?: { runClosed?: boolean; handOffset?: HandOffset | null } }).data;
      setOpen(null);
      onDecided(offset, result?.runClosed === true, result?.handOffset ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The decision was not recorded — please try again');
      setOpen(null);
    } finally {
      setSaving(false);
    }
  }

  const dialog = open ? DIALOG[open] : null;
  return (
    <li className="text-xs text-amber-500">
      <span>
        Line {offset.lineDate} · {rands(offset.lineAmount)} · {offset.lineDescription}: {offset.entryNumber} (
        {offset.entryDate} · {rands(offset.amount)} · {offset.description}) may already correct this posting —
        reverse that journal and undo again, or decide below.
      </span>{' '}
      <button type="button" onClick={() => setOpen('confirmHandCorrection')} className="text-blue-500 hover:underline">
        Mark as corrected by hand
      </button>{' · '}
      <button type="button" onClick={() => setOpen('undoAnyway')} className="text-blue-500 hover:underline">
        Not the correction — undo anyway
      </button>
      {error && <p className="text-red-400 mt-1">{error}</p>}
      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.title ?? ''}
        message={dialog?.body(offset) ?? ''}
        acceptLabel={dialog?.accept(offset) ?? ''}
        loading={saving}
        onAccept={() => { if (open) void decide(open); }}
        onCancel={() => setOpen(null)}
      />
    </li>
  );
}
