/**
 * ConfirmDialog — Shared confirmation dialog overlay.
 * Overlay click closes; inner div stopPropagation.
 * tone='destructive' styles the accept button red and makes it an alertdialog.
 * Semantics: aria-modal, labelled by the title and described by the message;
 * Escape cancels; Tab stays inside (same trap as Modal.tsx); focus returns to
 * the opener on close. Destructive opens on Cancel so a stray Enter is safe.
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
  onAccept,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = React.useId();
  const messageId = React.useId();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const destructive = tone === 'destructive';

  React.useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const buttons = rootRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
    (destructive ? buttons?.[0] : buttons?.[buttons.length - 1])?.focus();
    return () => opener?.focus();
  }, [open, destructive]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (!loading) onCancel(); return; }
    if (e.key !== 'Tab' || !rootRef.current) return;
    const focusable = Array.from(rootRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) { e.preventDefault(); return; }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !rootRef.current.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !rootRef.current.contains(active))) { e.preventDefault(); first.focus(); }
  };

  return (
    <div
      ref={rootRef}
      role={destructive ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
      onKeyDown={onKeyDown}
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
