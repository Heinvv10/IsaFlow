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
import { useEffect, useRef, useState } from 'react';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';
import { CommentaryEditor } from './CommentaryEditor';
import { commentaryCost } from '@/modules/accounting/services/commentary/commentaryLimits';

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
      /** `text` present = approve with the approver's own wording. Resolves
       *  true when the approval was accepted — a Promise, not void, so the
       *  editor can never be left open by a handler that forgot to say. */
      onApprove?: (id: string, text?: string) => Promise<boolean>;
      /** Whether this pack's approved text is held to the board pack's page-4
       *  budget (only the board pack prints it on a fixed sheet). Default true. */
      budgeted?: boolean;
      /** Re-fetch the rows; the editor offers it when it reports the pack over budget. */
      onRefresh?: () => void | Promise<void>;
      onReject?: (id: string) => void;
    };

/** The sentence as the row shows it, shortened: what the Edit button is for. */
function editLabel(sentence: string): string {
  const text = sentence.trim().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function PublishedList({ rows, sectionRef }: { rows: PublishedCommentaryRow[]; sectionRef: string }) {
  const mine = rows.filter(r => r.sectionRef === sectionRef && r.status === 'approved' && r.approvedText !== null);
  if (mine.length === 0) return null;
  return (
    <div className="mt-3 space-y-1" data-commentary="published">
      {mine.map(r => (
        <p key={r.id} className="break-words text-sm leading-relaxed text-[var(--ff-text-secondary)]">{r.approvedText}</p>
      ))}
    </div>
  );
}

export function CommentaryBlock(props: CommentaryBlockProps) {
  const { sectionRef, rows, mode } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const rowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const closedId = useRef<string | null>(null);
  // Closing the editor (cancel or success) returns focus to the row: its Edit
  // button while the row is still a draft, else the sentence itself.
  useEffect(() => {
    if (editingId !== null || closedId.current === null) return;
    const el = rowEls.current.get(closedId.current);
    closedId.current = null;
    (el?.querySelector<HTMLElement>('[data-edit]') ?? el?.querySelector<HTMLElement>('p'))?.focus();
  }, [editingId]);
  const closeEditor = (id: string) => { closedId.current = id; setEditingId(null); };
  if (mode === 'published') return <PublishedList rows={rows} sectionRef={sectionRef} />;
  const { onApprove, onReject, onRefresh, budgeted = true } = props;

  const mine = rows.filter(r => r.sectionRef === sectionRef && r.status !== 'rejected');
  if (mine.length === 0) return null;

  return (
    <div className="mt-3 space-y-2" data-commentary="internal">
      {mine.map(r => {
        const approved = r.status === 'approved' && r.approvedText !== null;
        if (!approved && onApprove && editingId === r.id) {
          return (
            <div key={r.id} className="flex items-start gap-2">
              <CommentaryEditor
                initialText={r.draftText}
                onRefresh={onRefresh}
                costWith={budgeted ? (text) => commentaryCost(
                  rows.filter(x => x.id === r.id || (x.status === 'approved' && x.approvedText !== null))
                    .map(x => (x.id === r.id ? text : x.approvedText ?? ''))) : null}
                onCancel={() => closeEditor(r.id)}
                onApprove={async text => {
                  const ok = await onApprove(r.id, text);
                  if (ok) closeEditor(r.id);
                  return ok;
                }}
              />
            </div>
          );
        }
        return (
          <div key={r.id} className="flex items-start gap-2"
            ref={el => { if (el) rowEls.current.set(r.id, el); else rowEls.current.delete(r.id); }}>
            <p tabIndex={-1} className="flex-1 break-words text-sm leading-relaxed text-[var(--ff-text-secondary)]">
              {approved ? r.approvedText : r.draftText}
            </p>
            {!approved && (
              <span className="shrink-0 rounded bg-[var(--ff-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--ff-text-tertiary)]">
                Draft — not published
              </span>
            )}
            {!approved && onApprove && (
              <button type="button" onClick={() => void onApprove(r.id)}
                className="shrink-0 rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)]">
                Approve
              </button>
            )}
            {!approved && onApprove && (
              <button type="button" data-edit aria-label={`Edit: ${editLabel(r.draftText)}`} onClick={() => setEditingId(r.id)}
                className="shrink-0 rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)]">
                Edit
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
