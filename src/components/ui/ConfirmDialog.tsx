/**
 * ConfirmDialog — Shared confirmation dialog overlay.
 * Overlay click closes; inner div stopPropagation.
 * tone='destructive' styles the accept button red and makes it an alertdialog.
 * Semantics: aria-modal, labelled by the title and described by the message;
 * Escape cancels; Tab stays inside (same trap as Modal.tsx); focus returns to
 * the opener on close. Opens on Cancel (autoFocusAccept opts out) so a stray Enter is safe. Escape from inside is
 * handled and stopped here, so a Modal underneath does not also close.
 */

import * as React from 'react';
import { XCircle } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  /** Label for the accept/confirm button */
  acceptLabel: string;
  /** Label for the cancel/dismiss button */
  cancelLabel?: string;
  tone?: 'default' | 'destructive';
  loading?: boolean;
  /** Opens on the accept button. Default: Cancel, so a stray Enter never accepts. */
  autoFocusAccept?: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  acceptLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  loading = false,
  autoFocusAccept = false,
  onAccept,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = React.useId();
  const messageId = React.useId();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const destructive = tone === 'destructive';

  const latest = React.useRef({ loading, onCancel });
  React.useEffect(() => { latest.current = { loading, onCancel }; });

  React.useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const buttons = () => Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
    const initial = buttons();
    (autoFocusAccept ? initial[initial.length - 1] : initial[0])?.focus();
    // On the document, not the dialog: focus can sit outside it (a link just clicked, a page that stole it back).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (!latest.current.loading) latest.current.onCancel(); return; }
      if (e.key !== 'Tab' || !rootRef.current) return;
      const focusable = buttons();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      const active = document.activeElement;
      const inside = !!active && rootRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); opener?.focus(); };
  }, [open, autoFocusAccept]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role={destructive ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!loading) onCancel(); } }}
    >
      <div
        className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] shadow-2xl w-full max-w-sm mx-4 p-6 max-lg:flex max-lg:flex-col max-lg:max-h-[calc(100dvh-2rem)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-3 max-lg:shrink-0">
          {tone === 'destructive' && (
            <div className="p-2 rounded-full bg-red-500/10">
              <XCircle className="h-5 w-5 text-red-400" aria-hidden />
            </div>
          )}
          <h3 id={titleId} className="text-lg font-semibold text-[var(--ff-text-primary)]">{title}</h3>
        </div>
        <div id={messageId} className="text-sm text-[var(--ff-text-secondary)] mb-6 max-lg:break-words max-lg:overflow-y-auto max-lg:overscroll-contain">{message}</div>
        <div className="flex justify-end gap-2 max-lg:flex-wrap max-lg:shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg border border-[var(--ff-border-light)] disabled:opacity-50 max-lg:min-h-11"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={loading}
            className={cn(
              'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 max-lg:min-h-11',
              tone === 'destructive'
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-blue-600 hover:bg-blue-500',
            )}
          >
            {tone === 'destructive' && <XCircle className="h-4 w-4" />}
            {acceptLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
