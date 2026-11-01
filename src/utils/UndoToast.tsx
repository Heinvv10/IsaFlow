/**
 * The undoable toast's surface (notify.undoable). The library's own duration cannot pause on keyboard focus, so
 * this toast is opened with an infinite duration and dismisses itself on a timer of its own.
 */

import { useEffect, useRef, useState } from 'react';
import toast, { type Toast } from 'react-hot-toast';
import { CheckCircle2 } from 'lucide-react';

export const UNDO_TOAST_DEFAULT_MS = 8000;

export interface UndoOptions {
  onUndo: () => void | Promise<void>;
  durationMs?: number;
  /** A second line. Never truncated: it may say what undo does not do. */
  message?: string;
}

interface Props {
  t: Toast;
  title: string;
  opts: UndoOptions;
  undoOnce: () => void;
}

export function UndoToast({ t, title, opts, undoOnce }: Props) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(opts.durationMs ?? UNDO_TOAST_DEFAULT_MS);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(() => toast.dismiss(t.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(remaining.current - (Date.now() - startedAt), 0);
    };
  }, [paused, t.id]);

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={`${t.visible ? 'animate-slide-up' : 'opacity-0 translate-y-2'}
        pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl
        bg-[var(--ff-surface-elevated)] border border-[var(--ff-border-primary)]
        shadow-lg shadow-black/20 ring-1 ring-[var(--ff-border-subtle)]
        px-4 py-3 transition-all duration-300`}
    >
      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--ff-text-primary)] leading-tight">{title}</p>
        {opts.message && <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5 leading-snug">{opts.message}</p>}
      </div>
      <button
        type="button"
        onClick={() => { toast.dismiss(t.id); undoOnce(); }}
        className="shrink-0 rounded-md px-2 py-0.5 text-sm font-semibold text-teal-700 hover:bg-teal-500/10 dark:text-teal-300 ff-focus-ring"
      >
        Undo
      </button>
    </div>
  );
}
