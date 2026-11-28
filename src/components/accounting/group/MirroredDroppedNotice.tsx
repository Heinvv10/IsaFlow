/**
 * Mirrored rows the group figures keep UN-eliminated (mirrorEliminations.ts reports them with the derivation: the mirror is automatic, so
 * nobody would notice otherwise). Shown on the consolidated reports and the Eliminations page, in two kinds:
 *  - 'unmapped': an account of the mirrored documents has no group account mapped, so the event was left out whole (map the accounts);
 *  - 'unresolved': the row has NO elimination from any path (the receiver's journal does not carry the sender's figures, the receiver
 *    cancelled its document, or rejected / dismissed / failed to accept it). The list is INFORMATIONAL: eliminating a mirrored row by hand is not
 *    available yet (docs/plans/2026-11-22-intercompany-manual-elimination-of-mirrored-rows.md), so each row says what to correct on the receiver's side.
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

/** What fixes an unresolved row, by why it is one and what the document is: with no receiver expense (cancelled, rejected, dismissed, failed) the sender's revenue stands alone. */
const ADVICE: Record<string, (doc: string) => string> = {
  variance: (d) => `Fix: the receiver corrects or re-books its document so that it carries the sender's figures in the same financial year, or the sender cancels ${d === 'sale' ? 'or credits ' : ''}the ${d}.`,
  cancelled: (d) => `Fix: the receiver books its document again, or the sender cancels ${d === 'sale' ? 'or credits ' : ''}the ${d}.`,
  rejected: (d) => `Fix: the receiver booked no expense for this ${d}. A rejection is final and the same ${d} cannot be sent again: the sender cancels the ${d} and issues it afresh.`,
  dismissed: (d) => `Fix: the receiver booked no expense for this ${d}. It can restore the message and accept it, or the sender cancels the ${d}.`,
  failed: (d) => `Fix: the receiver booked no expense for this ${d}. It can accept the message itself, or the sender cancels the ${d}.`,
};

export function MirroredDroppedNotice({ rows }: { rows: DroppedMirrored[] }) {
  const unmapped = rows.filter((r) => r.kind !== 'unresolved');
  const unresolved = rows.filter((r) => r.kind === 'unresolved');
  return (
    <>
      {unmapped.length > 0 && (
        <Block title={`${unmapped.length} mirrored ${unmapped.length === 1 ? 'elimination' : 'eliminations'} not applied: an account has no group account mapped`}
          help="The group figures still include that intercompany revenue and expense. Map the accounts of these documents to group accounts.">
          {unmapped.map((r) => <li key={`${r.transactionId}:${r.keyDate}`}>{r.keyDate}: {r.description} ({formatMoney(r.amount)})</li>)}
        </Block>
      )}
      {unresolved.length > 0 && (
        <Block title={`${unresolved.length} mirrored ${unresolved.length === 1 ? 'document has' : 'documents have'} no elimination`}
          help="No path eliminates these (see the reason on each). Eliminating a mirrored row by hand is not available yet, and a mirrored row is never drafted or matched by hand, so the group figures still include the sender's revenue, and the receiver's expense only where the receiver booked one. Each line says what puts the document right.">
          {unresolved.map((r) => (
            <li key={`${r.transactionId}:${r.keyDate}`}>
              {r.keyDate}: {r.description} ({formatMoney(r.amount)}): {r.detail}
              {r.code && ADVICE[r.code] ? ` ${ADVICE[r.code]!(docWord(r.amount))}` : ''}
            </li>
          ))}
        </Block>
      )}
    </>
  );
}
