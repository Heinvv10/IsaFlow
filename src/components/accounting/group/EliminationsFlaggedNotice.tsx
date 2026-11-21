/**
 * What the auto-generator drafted with a flag in THIS run: eliminations of manual intercompany rows that may be the same sale as a mirrored
 * document (whose elimination is automatic). They are drafts like any other, marked CHECK BEFORE POSTING: posting one would eliminate the
 * sale twice. Nothing is ever left out.
 */
import { AlertTriangle } from 'lucide-react';

export interface FlaggedRow { transactionId: string; adjustmentId: string; mirroredRef: string; reason: string }

/** The `flagged` list of an auto-eliminate response, keeping only well-formed entries (a malformed body gives none). */
export function parseFlagged(json: unknown): FlaggedRow[] {
  const data = (json as { data?: { flagged?: unknown } } | null)?.data;
  const list = Array.isArray(data?.flagged) ? data.flagged : [];
  return list.flatMap((r: unknown) => {
    const x = r as Partial<FlaggedRow>;
    if (typeof x?.transactionId !== 'string' || typeof x.reason !== 'string') return [];
    return [{ transactionId: x.transactionId, adjustmentId: typeof x.adjustmentId === 'string' ? x.adjustmentId : '',
              mirroredRef: typeof x.mirroredRef === 'string' ? x.mirroredRef : '', reason: x.reason }];
  });
}

export function EliminationsFlaggedNotice({ rows, onDismiss }: { rows: FlaggedRow[]; onDismiss: () => void }) {
  if (rows.length === 0) return null;
  return (
    <div role="status" aria-label="Auto-generate notes"
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-[var(--ff-text-primary)] mb-6">
      <div className="flex gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" aria-hidden="true" />
        <div>
          {rows.length} {rows.length === 1 ? 'elimination was' : 'eliminations were'} drafted with a flag: possibly the same sale as a mirrored
          document, whose elimination is automatic. Check each before posting: posting it would eliminate the sale twice.
          <ul className="mt-1 space-y-0.5 list-disc pl-5 text-[var(--ff-text-secondary)]">
            {rows.map((r) => <li key={r.transactionId}><span className="font-id">{r.transactionId.slice(0, 8)}</span>: {r.reason}</li>)}
          </ul>
        </div>
      </div>
      <button type="button" onClick={onDismiss}
        className="mt-2 min-h-[44px] min-w-[44px] px-3 rounded-md text-xs underline text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
        Dismiss
      </button>
    </div>
  );
}
