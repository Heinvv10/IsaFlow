/**
 * Mirrored rows the group figures keep UN-eliminated (mirrorEliminations.ts reports them with the derivation: the mirror is automatic, so
 * nobody would notice otherwise). Shown on the consolidated reports and the Eliminations page, in two kinds:
 *  - 'unmapped': an account of the mirrored documents has no group account mapped, so the event was left out whole (map the accounts);
 *  - 'unresolved': the row has NO elimination from any path (the receiver's journal does not carry the sender's figures, or the receiver
 *    cancelled its document): only a manual elimination with a reason can eliminate the sale.
 */
import { AlertCircle } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';

export interface DroppedMirrored { transactionId: string; keyDate: string; description: string; amount: number; kind: 'unmapped' | 'unresolved'; detail: string }

/** The `droppedMirrored` list of a response body (or its `data`), keeping only well-formed entries (a body without a kind is an unmapped one). */
export function parseDroppedMirrored(body: unknown): DroppedMirrored[] {
  const b = body as { droppedMirrored?: unknown; data?: { droppedMirrored?: unknown } } | null;
  const list = Array.isArray(b?.droppedMirrored) ? b.droppedMirrored : Array.isArray(b?.data?.droppedMirrored) ? b.data.droppedMirrored : [];
  return list.flatMap((r: unknown) => {
    const x = r as Partial<DroppedMirrored>;
    return typeof x?.transactionId === 'string' && typeof x.amount === 'number'
      ? [{ transactionId: x.transactionId, keyDate: String(x.keyDate ?? ''), description: String(x.description ?? ''), amount: x.amount,
           kind: x.kind === 'unresolved' ? 'unresolved' as const : 'unmapped' as const, detail: String(x.detail ?? '') }] : [];
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
        <Block title={`${unresolved.length} mirrored ${unresolved.length === 1 ? 'sale has' : 'sales have'} no elimination`}
          help="The receiver's books do not support the elimination of these (see the reason on each), and a mirrored row is never drafted or matched by hand, so the group figures still include that intercompany revenue and expense. Make a manual elimination with a reason, or have the receiver correct its document.">
          {unresolved.map((r) => <li key={`${r.transactionId}:${r.keyDate}`}>{r.keyDate}: {r.description} ({formatMoney(r.amount)}): {r.detail}</li>)}
        </Block>
      )}
    </>
  );
}
