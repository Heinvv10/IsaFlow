/**
 * Mirrored rows the group figures keep UN-eliminated (mirrorEliminations.ts reports them with the derivation: the mirror is automatic, so
 * nobody would notice otherwise). Shown on the consolidated reports and the Eliminations page, in two kinds:
 *  - 'unmapped': an account of the mirrored documents has no group account mapped, so the event was left out whole (map the accounts);
 *  - 'unresolved': the row has NO elimination from any path (the receiver's journal does not carry the sender's figures, the receiver
 *    cancelled its document, or rejected / dismissed / failed to accept it): only a manual elimination with a reason can eliminate the document
 *    (the row's "Eliminate this row" opens it carrying the row, so it unlists once posted);
 *  - 'stale' (a kind of unresolved, shown apart): a person's posted elimination still counts for a sale the sender has since cancelled; reverse it.
 */
import { AlertCircle } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';
import { docWord } from './EliminationsShared';

export interface DroppedMirrored { transactionId: string; keyDate: string; description: string; amount: number; kind: 'unmapped' | 'unresolved'; detail: string; code?: string }

/** The `droppedMirrored` list of a response body (or its `data`), keeping only well-formed entries (a body without a kind is an unmapped one). */
export function parseDroppedMirrored(body: unknown): DroppedMirrored[] {
  const b = body as { droppedMirrored?: unknown; data?: { droppedMirrored?: unknown } } | null;
  const list = Array.isArray(b?.droppedMirrored) ? b.droppedMirrored : Array.isArray(b?.data?.droppedMirrored) ? b.data.droppedMirrored : [];
  return list.flatMap((r: unknown) => {
    const x = r as Partial<DroppedMirrored>;
    return typeof x?.transactionId === 'string' && typeof x.amount === 'number'
      ? [{ transactionId: x.transactionId, keyDate: String(x.keyDate ?? ''), description: String(x.description ?? ''), amount: x.amount,
           kind: x.kind === 'unresolved' ? 'unresolved' as const : 'unmapped' as const, detail: String(x.detail ?? ''),
           ...(typeof x.code === 'string' && x.code ? { code: x.code } : {}) }] : [];
  });
}

const Block = ({ title, help, children }: { title: string; help: string; children: React.ReactNode }) => (
  <div role="alert" className="mb-6 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm">
    <p className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-400">
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      {title}
    </p>
    <p className="mt-1 text-[var(--ff-text-secondary)]">{help}</p>
    <ul className="mt-2 space-y-0.5 text-[var(--ff-text-tertiary)]">{children}</ul>
  </div>
);

/** What to do about an unresolved row, by why it is one and what the document is: with no receiver expense (cancelled, rejected, dismissed, failed) the sender's revenue stands alone. */
const CANCEL_NOTE = ' (an elimination you made of it by hand must then be reversed: it is listed here once the sale is cancelled)';
const ADVICE: Record<string, (doc: string) => string> = {
  cancelled: (d) => `The receiver cancelled its document, so it carries no expense for this ${d}: have it book the document again, or have the sender cancel ${d === 'sale' ? 'or credit ' : ''}the ${d}${CANCEL_NOTE}.`,
  rejected: (d) => `The receiver booked no expense for this ${d}: it returns to the sender's outbox to be corrected, or the sender can cancel the ${d}${CANCEL_NOTE}.`,
  dismissed: (d) => `The receiver booked no expense for this ${d}: it can restore the message and accept it, or the sender can cancel the ${d}${CANCEL_NOTE}.`,
  failed: (d) => `The receiver booked no expense for this ${d}: it can accept the message itself, or the sender can cancel the ${d}${CANCEL_NOTE}.`,
  drafted: () => 'A manual elimination of it is drafted: post it below.',
};

export function MirroredDroppedNotice({ rows, onEliminate }: { rows: DroppedMirrored[]; onEliminate?: (row: DroppedMirrored) => void }) {
  const unmapped = rows.filter((r) => r.kind !== 'unresolved');
  const unresolved = rows.filter((r) => r.kind === 'unresolved' && r.code !== 'stale');
  const stale = rows.filter((r) => r.kind === 'unresolved' && r.code === 'stale');
  return (
    <>
      {unmapped.length > 0 && (
        <Block title={`${unmapped.length} mirrored ${unmapped.length === 1 ? 'elimination' : 'eliminations'} not applied: an account has no group account mapped`}
          help="The group figures still include that intercompany revenue and expense. Map the accounts of these documents to group accounts.">
          {unmapped.map((r) => <li key={`${r.transactionId}:${r.keyDate}`}>{r.keyDate}: {r.description} ({formatMoney(r.amount)})</li>)}
        </Block>
      )}
      {stale.length > 0 && (
        <Block title={`${stale.length} manual ${stale.length === 1 ? 'elimination covers' : 'eliminations cover'} a sale the sender cancelled`}
          help="Each still counts in the group figures, but the sale it eliminates is no longer in the sender's books: reverse the elimination below (it counts until you do).">
          {stale.map((r) => <li key={`${r.transactionId}:${r.keyDate}`}>{r.keyDate}: {r.description} ({formatMoney(r.amount)}): {r.detail}</li>)}
        </Block>
      )}
      {unresolved.length > 0 && (
        <Block title={`${unresolved.length} mirrored ${unresolved.length === 1 ? 'document has' : 'documents have'} no elimination`}
          help="Nothing eliminates these (see the reason on each), and a mirrored row is never drafted or matched by hand, so the group figures still include the sender's revenue, and the receiver's expense only where the receiver booked one. Make a manual elimination with a reason, or have the documents put right.">
          {unresolved.map((r) => (
            <li key={`${r.transactionId}:${r.keyDate}`}>
              {r.keyDate}: {r.description} ({formatMoney(r.amount)}): {r.detail}
              {r.code && ADVICE[r.code] ? ` ${ADVICE[r.code]!(docWord(r.amount))}` : ''}
              {onEliminate && r.code !== 'drafted' && (
                <button type="button" onClick={() => onEliminate(r)} className="ml-2 underline text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Eliminate this row</button>
              )}
            </li>
          ))}
        </Block>
      )}
    </>
  );
}
