/**
 * What the auto-generator left out or flagged: manual intercompany rows that are the same sale as a mirrored document (not eliminated, the
 * mirrored document's elimination is derived) and rows it drafted with a flag because the match was not certain (check before posting).
 */
import { AlertTriangle, Info } from 'lucide-react';

export interface SkippedRow { transactionId: string; action: 'skipped' | 'flagged'; reason: string }

/** The `skipped` list of an auto-eliminate response, keeping only well-formed entries. */
export function parseSkipped(json: unknown): SkippedRow[] {
  const data = (json as { data?: { skipped?: unknown } } | null)?.data;
  const list = Array.isArray(data?.skipped) ? data.skipped : [];
  return list.flatMap((r: unknown) => {
    const x = r as Partial<SkippedRow>;
    if (typeof x?.transactionId !== 'string' || typeof x.reason !== 'string') return [];
    return [{ transactionId: x.transactionId, action: x.action === 'flagged' ? 'flagged' : 'skipped', reason: x.reason }];
  });
}

export function EliminationsSkippedNotice({ rows, onDismiss }: { rows: SkippedRow[]; onDismiss: () => void }) {
  if (rows.length === 0) return null;
  const skipped = rows.filter((r) => r.action === 'skipped');
  const flagged = rows.filter((r) => r.action === 'flagged');
  const list = (items: SkippedRow[]) => (
    <ul className="mt-1 space-y-0.5 list-disc pl-5">
      {items.map((r) => <li key={`${r.action}:${r.transactionId}`}><span className="font-mono">{r.transactionId.slice(0, 8)}</span>: {r.reason}</li>)}
    </ul>
  );
  return (
    <div role="status" aria-label="Auto-generate notes" className="p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 text-sm mb-6">
      {skipped.length > 0 && (
        <div className="flex gap-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            {skipped.length} manual intercompany {skipped.length === 1 ? 'row was' : 'rows were'} not eliminated: the same sale as a mirrored
            document, whose elimination is automatic.
            {list(skipped)}
          </div>
        </div>
      )}
      {flagged.length > 0 && (
        <div className={`flex gap-2 ${skipped.length > 0 ? 'mt-2' : ''}`}>
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            {flagged.length} {flagged.length === 1 ? 'elimination was' : 'eliminations were'} drafted with a flag: possibly the same sale as a
            mirrored document. Check before posting.
            {list(flagged)}
          </div>
        </div>
      )}
      <button type="button" onClick={onDismiss} className="mt-2 text-xs underline">Dismiss</button>
    </div>
  );
}
