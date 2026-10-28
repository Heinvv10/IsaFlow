/**
 * The save bar (spec §5.6, §6.4): "N unsaved changes · Save · Discard", fixed to the bottom of
 * the viewport over the content column (`<main>`, measured), so it stays in view however far the
 * page is scrolled sideways by the grid: a `sticky` bar inside the page scrolled out of view at
 * 390 px (proof F1). It sits above `<main>`'s horizontal scrollbar, and an in-flow spacer as tall
 * as the bar (measured: it wraps on a long error) keeps the last rows clear of it. The page stays the only
 * scroll container (stickyTable rule). Saving shows a spinner and the grid stays editable (the save sends a snapshot); a
 * failed save (not a 409, which is StaleVersionDialog's) is said inline and the dirty cells stay.
 * Hidden when the version is read-only (locked, or the role cannot write). Ctrl+S is the grid's
 * (useGridKeyboard `onSave`); Discard asks first.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
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

/**
 * Where the fixed bar goes: over the content column (the nearest `<main>`: its left edge and
 * visible width), above that column's horizontal scrollbar (the grid scrolls `<main>` sideways),
 * and how tall the in-flow spacer must be (the bar's own height: it wraps when an error is long).
 */
function useBarPlacement(): [(el: HTMLElement | null) => void, CSSProperties, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<CSSProperties>({ left: 0, right: 0, bottom: 0 });
  const [height, setHeight] = useState(64);
  useEffect(() => {
    if (!el) return undefined;
    const column = el.closest('main');
    const measure = () => {
      setHeight(el.offsetHeight || 64);
      if (!column) return;
      const rect = column.getBoundingClientRect();
      const scrollbar = Math.max(0, column.offsetHeight - column.clientHeight);
      setBox({ left: rect.left, width: column.clientWidth, bottom: Math.max(0, window.innerHeight - rect.bottom) + scrollbar });
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    if (column) ro?.observe(column);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, [el]);
  return [useCallback((node: HTMLElement | null) => setEl(node), []), box, height];
}

export function SaveBar({ dirtyCount, saveState, readOnly, onSave, onDiscard }: SaveBarProps) {
  const [confirming, setConfirming] = useState(false);
  const [barRef, box, barHeight] = useBarPlacement();
  if (readOnly) return null;
  const saving = saveState.status === 'saving';
  const status = statusText(saveState);
  if (dirtyCount === 0 && status === '' && !saving) return null;
  return (
    <>
    <div aria-hidden="true" style={{ height: barHeight }} data-testid="save-bar-spacer" />
    <div data-testid="save-bar" ref={barRef} style={box}
      className="fixed z-20 flex flex-wrap items-center gap-3 border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-4 py-3 sm:px-6">
      {dirtyCount > 0 && (
        <span className="text-sm font-medium text-[var(--ff-text-primary)]" data-testid="save-bar-count">
          {plural(dirtyCount, 'unsaved change')}
        </span>
      )}
      <span role={saveState.status === 'error' ? 'alert' : 'status'} data-testid="save-bar-status"
        className={`text-sm ${saveState.status === 'error' ? 'text-error-700 dark:text-error-400' : 'text-[var(--ff-text-secondary)]'}`}>
        {status}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={() => setConfirming(true)} disabled={dirtyCount === 0 || saving}
          className="rounded-lg border border-[var(--ff-border-light)] px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50">
          Discard
        </button>
        <button type="button" onClick={onSave} disabled={dirtyCount === 0 || saving} aria-keyshortcuts="Control+S" data-testid="save-bar-save"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
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
              className="rounded-lg bg-error-600 px-4 py-2 text-sm font-medium text-white hover:bg-error-700">Discard</button>
          </>}>
          <p>Discard {plural(dirtyCount, 'unsaved change')}? The cells go back to their saved amounts.</p>
        </WorkspaceDialog>
      )}
    </div>
    </>
  );
}
