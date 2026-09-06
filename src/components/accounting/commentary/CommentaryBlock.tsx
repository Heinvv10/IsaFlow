/**
 * Commentary printed directly under the figure it explains. THE ONE renderer
 * for both audiences — the owner's screen and a shared link.
 *
 * `mode` is the whole safety story, and it is enforced by the PROPS, not by a
 * branch. The published arm accepts `PublishedCommentaryRow[]`, which has no
 * `draftText` field at all — the published render has no code path to a draft,
 * rather than a conditional that happens to skip one.
 *
 * `status` IS in that type and the filter does use it, which looks redundant
 * next to `approvedText !== null` and is not: since migration 612 a WITHDRAWN
 * approval keeps its `approved_text` and moves to 'draft', precisely so the
 * database still records who signed off. Text alone therefore no longer means
 * published, and dropping the status check would put a withdrawn sentence back
 * in front of a reader.
 *
 * The share page previously had its own second published renderer
 * (`SharedPackView.CommentaryFor`). Two renderers for the one output that
 * leaves the building is one too many: the safety argument above has to hold
 * for whichever one is on the page, and only this file's argument was written
 * down. The share page now passes its server-side approved rows through here.
 *
 * The internal arm takes the full row and adds the draft, the badge and the
 * approve/reject controls.
 */
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';

/** Everything the published render needs and nothing it must not have. A full
 *  `CommentaryRow` satisfies it structurally, so the app can hand its own rows
 *  straight over; the share page maps its server rows onto it. */
export type PublishedCommentaryRow = Pick<CommentaryRow, 'id' | 'sectionRef' | 'status' | 'approvedText'>;

export type CommentaryBlockProps =
  | { mode: 'published'; sectionRef: string; rows: PublishedCommentaryRow[] }
  | {
      mode: 'internal';
      sectionRef: string;
      rows: CommentaryRow[];
      onApprove?: (id: string) => void;
      onReject?: (id: string) => void;
    };

function PublishedList({ rows, sectionRef }: { rows: PublishedCommentaryRow[]; sectionRef: string }) {
  const mine = rows.filter(r => r.sectionRef === sectionRef && r.status === 'approved' && r.approvedText !== null);
  if (mine.length === 0) return null;
  return (
    <div className="mt-3 space-y-1" data-commentary="published">
      {mine.map(r => (
        <p key={r.id} className="text-sm leading-relaxed text-[var(--ff-text-secondary)]">{r.approvedText}</p>
      ))}
    </div>
  );
}

export function CommentaryBlock(props: CommentaryBlockProps) {
  const { sectionRef, rows, mode } = props;
  if (mode === 'published') return <PublishedList rows={rows} sectionRef={sectionRef} />;
  const { onApprove, onReject } = props;

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
