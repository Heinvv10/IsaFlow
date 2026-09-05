/**
 * Commentary printed directly under the figure it explains.
 *
 * `mode` is the whole safety story. `toPublished` strips every row down to
 * `PublishedCommentaryRow` before `PublishedList` ever sees it — that type has
 * no `draftText` field, so the published render path has no code path to a
 * draft, not a conditional that happens to skip it. The share page and the
 * PDF pass 'published'; the app passes 'internal', which adds the draft, the
 * badge and the approve/reject controls.
 */
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';

export interface CommentaryBlockProps {
  sectionRef: string;
  rows: CommentaryRow[];
  mode: 'internal' | 'published';
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}

type PublishedCommentaryRow = Pick<CommentaryRow, 'id' | 'approvedText'>;

function toPublished(rows: CommentaryRow[], sectionRef: string): PublishedCommentaryRow[] {
  return rows
    .filter(r => r.sectionRef === sectionRef && r.status === 'approved' && r.approvedText !== null)
    .map(r => ({ id: r.id, approvedText: r.approvedText }));
}

function PublishedList({ rows }: { rows: PublishedCommentaryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 space-y-1" data-commentary="published">
      {rows.map(r => (
        <p key={r.id} className="text-sm leading-relaxed text-[var(--ff-text-secondary)]">{r.approvedText}</p>
      ))}
    </div>
  );
}

export function CommentaryBlock({ sectionRef, rows, mode, onApprove, onReject }: CommentaryBlockProps) {
  if (mode === 'published') return <PublishedList rows={toPublished(rows, sectionRef)} />;

  const mine = rows.filter(r => r.sectionRef === sectionRef && r.status !== 'rejected');
  if (mine.length === 0) return null;

  return (
    <div className="mt-3 space-y-2" data-commentary="internal">
      {mine.map(r => {
        const approved = r.status === 'approved' && r.approvedText !== null;
        return (
          <div key={r.id} className="flex items-start gap-2">
            <p className="flex-1 text-sm leading-relaxed text-[var(--ff-text-secondary)]">
              {approved ? r.approvedText : r.draftText}
            </p>
            {!approved && (
              <span className="shrink-0 rounded bg-[var(--ff-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--ff-text-tertiary)]">
                Draft — not published
              </span>
            )}
            {!approved && onApprove && (
              <button type="button" onClick={() => onApprove(r.id)}
                className="shrink-0 rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)]">
                Approve
              </button>
            )}
            {!approved && onReject && (
              <button type="button" onClick={() => onReject(r.id)}
                className="shrink-0 rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-tertiary)] hover:border-[var(--ff-unfav)]">
                Reject
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
