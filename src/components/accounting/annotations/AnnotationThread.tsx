/**
 * The note thread for one statement row. Internal surfaces only — the share
 * page does not import it and the share loader returns no annotations.
 *
 * NOT MOUNTED YET: no page renders this. Nothing on this branch owns an
 * account-row view for a note to hang off, so it is reachable from tests only.
 * See `src/modules/accounting/services/annotations/.claude.md`.
 *
 * It renders what it is given and calls back; it holds no annotation state of
 * its own beyond the unsent draft, so the page owning the list stays the one
 * source of truth after a create or a resolve.
 */
import { useState } from 'react';
import { useModalDialog } from '@/components/useModalDialog';
import type { Annotation } from '@/modules/accounting/services/annotations/annotationService';

const CARD = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]';
const BTN = 'rounded border border-[var(--ff-border-light)] px-2 py-0.5 text-xs text-[var(--ff-text-secondary)] hover:border-[var(--ff-brand-500)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]';

/** The author's name is optional in the schema — an invited user may have no
 *  display name yet — so the id is the fallback rather than an empty byline. */
function byline(a: Annotation): string {
  const who = a.authorName ?? a.author;
  return `${who} · ${new Date(a.createdAt).toLocaleDateString('en-ZA')}`;
}

export function AnnotationThread({ rowId, rowLabel, annotations, onCreate, onResolve, onClose }: {
  rowId: string;
  /** The row's own label — what the person reading the statement sees. The
   * dialog is announced with this, never with `rowId`: "Notes on acc:4000"
   * names an internal key, not the line the note is about. */
  rowLabel: string;
  annotations: Annotation[];
  onCreate: (body: string) => void;
  onResolve: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const mine = annotations.filter(a => a.rowId === rowId);
  const trimmed = draft.trim();
  // Focus on open, Tab trapped inside, Escape closes, focus back on the note
  // marker that opened it. See useModalDialog for why the container itself is
  // what takes focus.
  const dialogRef = useModalDialog<HTMLDivElement>(onClose);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={`${CARD} w-80 p-3 shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]`}
      role="dialog"
      aria-modal="true"
      aria-label={`Notes on ${rowLabel}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--ff-text-tertiary)]">Notes</h3>
        <button type="button" onClick={onClose} className={BTN} aria-label="Close notes">Close</button>
      </div>

      {mine.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--ff-text-tertiary)]">No notes on this row yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {mine.map(a => (
            <li key={a.id} className="border-t border-[var(--ff-border-light)] pt-2 first:border-t-0 first:pt-0">
              <p className="text-sm leading-relaxed text-[var(--ff-text-secondary)]">{a.body}</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[10px] text-[var(--ff-text-tertiary)]">{byline(a)}</span>
                {a.resolvedAt === null ? (
                  <button type="button" onClick={() => onResolve(a.id)} className={BTN}>Resolve</button>
                ) : (
                  <span className="text-[10px] uppercase tracking-wide text-[var(--ff-text-tertiary)]">Resolved</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <label className="mt-3 block">
        <span className="sr-only">New note</span>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={3}
          placeholder="Add a note for your team…"
          className="w-full rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2 text-sm text-[var(--ff-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]"
        />
      </label>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          disabled={trimmed.length === 0}
          onClick={() => { onCreate(trimmed); setDraft(''); }}
          className={`${BTN} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          Save
        </button>
      </div>
    </div>
  );
}
