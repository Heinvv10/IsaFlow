/** The note icon on a statement row. Internal surfaces only — the share page
 *  never imports it, and the share loader never returns annotations. */
import { MessageSquare } from 'lucide-react';
import type { StatementRowNote } from '@/modules/accounting/services/reports/statementRows/statementModel';

export function NoteMarker({ note, onClick, label }: {
  note: StatementRowNote; onClick: () => void; label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${note.count} ${note.count === 1 ? 'note' : 'notes'} on ${label}`}
      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]"
      style={{ color: note.hasOpen ? 'var(--ff-brand-500)' : 'var(--ff-text-tertiary)' }}
    >
      <MessageSquare className="h-3 w-3" />
      {note.count}
    </button>
  );
}
