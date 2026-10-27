/**
 * The save bar (spec §5.6, §6.4): "N unsaved changes · Save · Discard", sticky at the bottom of
 * the page. Saving shows a spinner and the grid stays editable (the save sends a snapshot); a
 * failed save (not a 409, which is StaleVersionDialog's) is said inline and the dirty cells stay.
 * Hidden when the version is read-only (locked, or the role cannot write). Ctrl+S is the grid's
 * (useGridKeyboard `onSave`); Discard asks first.
 */
import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { WorkspaceDialog } from './VersionStatusDialogs';
import type { SaveState } from './types';

export interface SaveBarProps {
  dirtyCount: number;
  saveState: SaveState;
  /** Locked, or a role without write access: no bar. */
  readOnly: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function statusText(s: SaveState): string {
  if (s.status === 'saved') return `Saved: ${plural(s.saved, 'cell')} changed, ${plural(s.deleted, 'cell')} cleared`;
  if (s.status === 'error') return s.retryAfter ? `${s.message} Try again in ${s.retryAfter} s.` : s.message;
  return '';
}

export function SaveBar({ dirtyCount, saveState, readOnly, onSave, onDiscard }: SaveBarProps) {
  const [confirming, setConfirming] = useState(false);
  if (readOnly) return null;
  const saving = saveState.status === 'saving';
  const status = statusText(saveState);
  if (dirtyCount === 0 && status === '' && !saving) return null;
  return (
    <div data-testid="save-bar"
      className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-4 py-3 sm:px-6">
      {dirtyCount > 0 && (
        <span className="text-sm font-medium text-[var(--ff-text-primary)]" data-testid="save-bar-count">
          {plural(dirtyCount, 'unsaved change')}
        </span>
      )}
      <span role={saveState.status === 'error' ? 'alert' : 'status'} data-testid="save-bar-status"
        className={`text-sm ${saveState.status === 'error' ? 'text-[var(--ff-error-500)]' : 'text-[var(--ff-text-secondary)]'}`}>
        {status}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={() => setConfirming(true)} disabled={dirtyCount === 0 || saving}
          className="rounded-lg border border-[var(--ff-border-light)] px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50">
          Discard
        </button>
        <button type="button" onClick={onSave} disabled={dirtyCount === 0 || saving} aria-keyshortcuts="Control+S"
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ff-brand)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {confirming && (
        <WorkspaceDialog title="Discard changes" onClose={() => setConfirming(false)} testId="discard-dialog"
          footer={<>
            <button type="button" onClick={() => setConfirming(false)}
              className="rounded-lg border border-[var(--ff-border-light)] px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Keep editing</button>
            <button type="button" onClick={() => { setConfirming(false); onDiscard(); }}
              className="rounded-lg bg-[var(--ff-error-500)] px-4 py-2 text-sm font-medium text-white">Discard</button>
          </>}>
          <p>Discard {plural(dirtyCount, 'unsaved change')}? The cells go back to their saved amounts.</p>
        </WorkspaceDialog>
      )}
    </div>
  );
}
