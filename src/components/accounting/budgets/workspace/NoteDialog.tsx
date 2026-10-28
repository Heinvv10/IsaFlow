/**
 * "Add note… / Edit note…" (P2 follow-up F1): edits one account's budget note for the financial
 * year. A note is year-scoped, so the helper says every version of the year shows it. Save sends the
 * text through `onSave` (the server trims it; blank clears it) and closes on success; a refusal keeps
 * the dialog open with the server's message. The note is saved on its own, never with the grid's
 * amounts, so unsaved cells and undo are untouched. Escape / Cancel close without saving.
 */
import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

/** The server's limit (budgetNotes MAX_NOTE_LENGTH), after trimming. */
export const NOTE_MAX = 2000;

export interface NoteTarget {
  accountId: string;
  /** "1000 Sales" */
  accountLabel: string;
  note: string | null;
}

interface NoteDialogProps {
  target: NoteTarget;
  fiscalYear: number;
  /** Null when saved (the dialog closes), else the message to show. */
  onSave(note: string): Promise<string | null>;
  onClose(): void;
}

export function NoteDialog({ target, fiscalYear, onSave, onClose }: NoteDialogProps) {
  const [text, setText] = useState(target.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const length = text.trim().length;
  const tooLong = length > NOTE_MAX;

  const save = async () => {
    setBusy(true);
    setError(null);
    const message = await onSave(text);
    setBusy(false);
    if (message !== null) setError(message);
  };

  return (
    <Modal open onClose={busy ? () => undefined : onClose} title={`Note for ${target.accountLabel}`} size="md">
      <Modal.Body className="space-y-2 text-sm">
        <label htmlFor={id} className="block font-medium text-[var(--ff-text-primary)]">Note</label>
        <textarea id={id} value={text} onChange={e => setText(e.target.value)} rows={4} disabled={busy}
          aria-describedby={`${id}-help ${id}-count`} aria-invalid={tooLong}
          className="w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] p-2 text-[var(--ff-text-primary)]" />
        <p id={`${id}-help`} className="text-xs text-[var(--ff-text-secondary)]">
          Shown on every version of FY{fiscalYear}, locked ones included. Leave it empty to remove the note.
        </p>
        <p id={`${id}-count`} className={`text-xs ${tooLong ? 'text-error-700 dark:text-error-400' : 'text-[var(--ff-text-tertiary)]'}`}>
          {length} / {NOTE_MAX} characters
        </p>
        {error && <p role="alert" className="text-sm text-error-700 dark:text-error-400">{error}</p>}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="button" disabled={busy || tooLong} onClick={() => { void save(); }}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Save note
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
