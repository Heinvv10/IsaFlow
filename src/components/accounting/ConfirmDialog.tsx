/**
 * Modal confirmation dialog. Replaces window.confirm() / window.prompt() for
 * destructive or significant actions where we need styled, accessible
 * confirmation.
 */

import { useEffect, useId, useRef } from 'react';
import { AlertTriangle, X, Loader2 } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmTone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmTone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // For destructive actions, focus Cancel so a quick Enter on a freshly-
    // opened dialog can't fire the irreversible action by accident. Primary
    // (non-destructive) actions still focus Confirm so the keyboard-first
    // flow for the common path is one keystroke.
    if (confirmTone === 'danger') cancelBtn.current?.focus();
    else confirmBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel, confirmTone]);

  if (!open) return null;

  const confirmCls = confirmTone === 'danger'
    ? 'bg-red-600 hover:bg-red-700 text-white'
    : 'bg-teal-600 hover:bg-teal-700 text-white';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 shadow-xl border border-zinc-200 dark:border-slate-700"
      >
        <div className="flex items-start justify-between border-b border-zinc-100 dark:border-slate-800 px-5 py-3 gap-3">
          <div className="flex items-start gap-2">
            {/* Warning icon only on destructive actions — primary tone shouldn't
                signal danger. */}
            {confirmTone === 'danger' && (
              <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-500 flex-shrink-0" aria-hidden />
            )}
            <h2 id={titleId} className="text-base font-semibold text-zinc-900 dark:text-white">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-slate-800 text-zinc-500 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 text-sm text-zinc-700 dark:text-slate-200 whitespace-pre-line">
          {message}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 dark:border-slate-800 px-5 py-3 bg-zinc-50 dark:bg-slate-950 rounded-b-xl">
          <button
            ref={cancelBtn}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-sm text-zinc-700 dark:text-slate-200 hover:bg-zinc-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtn}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50 ${confirmCls}`}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
