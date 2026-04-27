/**
 * ConfirmDialog — Shared confirmation dialog overlay.
 * Overlay click closes; inner div stopPropagation.
 * tone='destructive' styles the accept button red.
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
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] shadow-2xl w-full max-w-sm mx-4 p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-3">
          {tone === 'destructive' && (
            <div className="p-2 rounded-full bg-red-500/10">
              <XCircle className="h-5 w-5 text-red-400" />
            </div>
          )}
          <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">{title}</h3>
        </div>
        <div className="text-sm text-[var(--ff-text-secondary)] mb-6">{message}</div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg border border-[var(--ff-border-light)] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={loading}
            className={cn(
              'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50',
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
