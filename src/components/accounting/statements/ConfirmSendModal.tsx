/**
 * ConfirmSendModal
 * Shown before bulk-sending statements. Displays count and as-at date,
 * then calls onConfirm or onCancel.
 */

import { Loader2, Mail, X } from 'lucide-react';

interface Props {
  count: number;
  asAtDate: string;
  isSending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const fmtDate = (d: string): string => {
  const parts = d.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
};

export function ConfirmSendModal({ count, asAtDate, isSending, onConfirm, onCancel }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-send-title"
    >
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <Mail className="h-5 w-5 text-purple-500" />
            </div>
            <h2
              id="confirm-send-title"
              className="text-lg font-semibold text-[var(--ff-text-primary)]"
            >
              Confirm Statement Send
            </h2>
          </div>
          <button
            onClick={onCancel}
            disabled={isSending}
            className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-3 text-sm text-[var(--ff-text-secondary)]">
          <p>
            You are about to email account statements to{' '}
            <span className="font-semibold text-[var(--ff-text-primary)]">
              {count} customer{count !== 1 ? 's' : ''}
            </span>
            .
          </p>
          <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)]">
            <span className="text-[var(--ff-text-tertiary)]">Statement date:</span>
            <span className="font-medium text-[var(--ff-text-primary)]">{fmtDate(asAtDate)}</span>
          </div>
          <p className="text-xs text-[var(--ff-text-tertiary)]">
            Each customer will receive their outstanding transactions as at the statement date.
            Customers without an email address are excluded.
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            disabled={isSending}
            className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isSending}
            className="inline-flex items-center gap-2 px-5 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-60 transition-colors"
          >
            {isSending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Mail className="h-4 w-4" />
                Send {count} Statement{count !== 1 ? 's' : ''}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
