/**
 * What the auto-generator did in THIS run beyond drafting: the drafts it flagged (manual rows that may be the same sale as a mirrored document,
 * marked CHECK BEFORE POSTING) and the rows it left to mirroring (RULING 2026-11-21: a mirroring pair's sale-class rows dated on or after the
 * pair's cutover, "eliminated by mirroring").
 */
import { AlertTriangle } from 'lucide-react';

export interface FlaggedRow { transactionId: string; adjustmentId: string; mirroredRef: string; reason: string }
export interface SkippedRow { transactionId: string; reason: string; cutover: string }

/** The `skipped` list of an auto-eliminate response, keeping only well-formed entries. */
export function parseSkipped(json: unknown): SkippedRow[] {
  const data = (json as { data?: { skipped?: unknown } } | null)?.data;
  const list = Array.isArray(data?.skipped) ? data.skipped : [];
  return list.flatMap((r: unknown) => {
    const x = r as Partial<SkippedRow>;
    return typeof x?.transactionId === 'string' && typeof x.reason === 'string'
      ? [{ transactionId: x.transactionId, reason: x.reason, cutover: typeof x.cutover === 'string' ? x.cutover : '' }] : [];
  });
}

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

export function EliminationsFlaggedNotice({ rows, skipped = [], onDismiss }: { rows: FlaggedRow[]; skipped?: SkippedRow[]; onDismiss: () => void }) {
  if (rows.length === 0 && skipped.length === 0) return null;
  return (
    <div role="status" aria-label="Auto-generate notes"
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-[var(--ff-text-primary)] mb-6">
      <div className="flex gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" aria-hidden="true" />
        <div>
          {rows.length > 0 && <>
            {rows.length} {rows.length === 1 ? 'elimination was' : 'eliminations were'} drafted with a flag: possibly the same sale as a mirrored
            document. Check each before posting.
            <ul className="mt-1 space-y-0.5 list-disc pl-5 text-[var(--ff-text-secondary)]">
              {rows.map((r) => <li key={r.transactionId}><span className="font-id">{r.transactionId.slice(0, 8)}</span>: {r.reason}</li>)}
            </ul>
          </>}
          {skipped.length > 0 && <p className={rows.length > 0 ? 'mt-2' : ''}>
            {skipped.length} intercompany {skipped.length === 1 ? 'row was' : 'rows were'} not drafted, eliminated by mirroring (the pair mirrors
            from {[...new Set(skipped.map((r) => r.cutover))].join(', ')}):{' '}
            <span className="font-id">{skipped.map((r) => r.transactionId.slice(0, 8)).join(', ')}</span>
          </p>}
        </div>
      </div>
      <button type="button" onClick={onDismiss}
        className="mt-2 min-h-[44px] min-w-[44px] px-3 rounded-md text-xs underline text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
        Dismiss
      </button>
    </div>
  );
}
