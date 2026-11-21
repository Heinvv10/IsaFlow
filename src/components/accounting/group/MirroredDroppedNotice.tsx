/**
 * Mirrored eliminations the period could NOT apply: an account of the mirrored documents has no group account mapped, so the group figures still
 * carry that intercompany revenue and expense (mirrorEliminations.ts leaves the event out whole). Shown on the consolidated reports and the
 * Eliminations page: the mirror is automatic, so nobody would notice otherwise.
 */
import { AlertCircle } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';

export interface DroppedMirrored { transactionId: string; keyDate: string; description: string; amount: number }

/** The `droppedMirrored` list of a response body (or its `data`), keeping only well-formed entries. */
export function parseDroppedMirrored(body: unknown): DroppedMirrored[] {
  const b = body as { droppedMirrored?: unknown; data?: { droppedMirrored?: unknown } } | null;
  const list = Array.isArray(b?.droppedMirrored) ? b.droppedMirrored : Array.isArray(b?.data?.droppedMirrored) ? b.data.droppedMirrored : [];
  return list.flatMap((r: unknown) => {
    const x = r as Partial<DroppedMirrored>;
    return typeof x?.transactionId === 'string' && typeof x.amount === 'number'
      ? [{ transactionId: x.transactionId, keyDate: String(x.keyDate ?? ''), description: String(x.description ?? ''), amount: x.amount }] : [];
  });
}

export function MirroredDroppedNotice({ rows }: { rows: DroppedMirrored[] }) {
  if (rows.length === 0) return null;
  return (
    <div role="alert" className="mb-6 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-400">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        {rows.length} mirrored {rows.length === 1 ? 'elimination' : 'eliminations'} not applied: an account has no group account mapped
      </p>
      <p className="mt-1 text-[var(--ff-text-secondary)]">
        The group figures still include that intercompany revenue and expense. Map the accounts of these documents to group accounts.
      </p>
      <ul className="mt-2 space-y-0.5 text-[var(--ff-text-tertiary)]">
        {rows.map((r) => <li key={`${r.transactionId}:${r.keyDate}`}>{r.keyDate}: {r.description} ({formatMoney(r.amount)})</li>)}
      </ul>
    </div>
  );
}
