/**
 * R-079 — a line the auto-post undo refused because a later journal may
 * already correct its posting. Reversing the posting too would apply a hand
 * correction twice. When the journal nets the posting out, the user may mark it
 * as the correction (posts nothing). When it does not — a reclass or a partial
 * correction — the answer is to reverse that journal first, then undo, and the
 * notice says so. "Undo anyway" stays available behind a dialog that shows each
 * account now and after the undo, so a double correction is visible before
 * anyone confirms. Every decision is recorded; none is one click.
 */

import { useState, type ReactNode } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
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
  netsPostingOut: boolean;
  reclass: boolean;
  projection: Array<{ accountCode: string; accountName: string; now: number; afterUndo: number }>;
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

function Projection({ offset }: { offset: HandOffset }) {
  return (
    <table aria-label="Balances after the undo" className="mt-3 w-full text-xs">
      <thead>
        <tr><th className="text-left">Account</th><th className="text-right">Now</th><th className="text-right">After undo</th></tr>
      </thead>
      <tbody>
        {offset.projection.map((p) => (
          <tr key={p.accountCode}>
            <td>{p.accountCode} {p.accountName}</td>
            <td className="text-right">{rands(p.now)}</td>
            <td className="text-right">{rands(p.afterUndo)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const DIALOG: Record<Decision, { title: string; accept: (o: HandOffset) => string; body: (o: HandOffset) => ReactNode }> = {
  confirmHandCorrection: {
    title: 'Mark as corrected by hand',
    accept: (o) => `Mark ${o.entryNumber} as the correction`,
    body: (o) => `Treat ${o.entryNumber} as the correction of this auto-posted line. Nothing will be posted or `
      + 'reversed: the books stay as they are now, the line leaves this run, and the decision is recorded under your name.',
  },
  undoAnyway: {
    title: 'Not the correction — undo anyway',
    accept: () => 'Undo the line anyway',
    body: (o) => (
      <>
        {o.netsPostingOut
          ? `${o.entryNumber} is unrelated to this line. `
          : `This is not what reversing ${o.entryNumber} gives: the auto-posting is reversed and ${o.entryNumber} stays, `
            + 'so the accounts below keep its move. '}
        The decision is recorded under your name.
        <Projection offset={o} />
      </>
    ),
  },
};

/** What to do about the journal, in words: mark it, or reverse it first. */
function guidance(o: HandOffset): ReactNode {
  const je = <a href={`/accounting/journal-entries/${o.journalEntryId}`} className="underline">{o.entryNumber}</a>;
  if (o.netsPostingOut) return <>{je} may be the correction of this posting — mark it as the correction, or undo anyway.</>;
  return (
    <>
      {je} {o.reclass ? 'moved this posting to another account' : 'moves part of this posting back'}. Reverse{' '}
      {o.entryNumber} first (Journal Entries › {o.entryNumber} › Reverse), then undo.
    </>
  );
}

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
      await assertOk(res, 'The decision was not recorded - please try again');
      const result = ((await res.json().catch(() => null)) as { data?: { runClosed?: boolean; handOffset?: HandOffset | null } } | null)?.data;
      setOpen(null);
      onDecided(offset, result?.runClosed === true, result?.handOffset ?? null);
    } catch (err) {
      setError(apiErrorMessage(err, 'The decision was not recorded - please try again'));
      setOpen(null);
    } finally {
      setSaving(false);
    }
  }

  const dialog = open ? DIALOG[open] : null;
  return (
    <li className="text-xs text-amber-500">
      <span>
        Line {offset.lineDate} · {rands(offset.lineAmount)} · {offset.lineDescription} — journal (
        {offset.entryDate} · {rands(offset.amount)} · {offset.description}): {guidance(offset)}
      </span>{' '}
      {offset.netsPostingOut && (
        <>
          <button type="button" onClick={() => setOpen('confirmHandCorrection')} className="text-blue-600 dark:text-blue-400 hover:underline">
            Mark as corrected by hand
          </button>{' · '}
        </>
      )}
      <button type="button" onClick={() => setOpen('undoAnyway')} className="text-blue-600 dark:text-blue-400 hover:underline">
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
