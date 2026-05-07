/**
 * InvoiceEmailModal — Send invoice by email.
 * Overlay click closes; inner div stopPropagation.
 */

import { Loader2, Send, CheckCircle2, AlertCircle, X } from 'lucide-react';

interface Props {
  open: boolean;
  invoiceNumber: string;
  emailTo: string;
  emailSending: boolean;
  emailSuccess: string;
  emailSentAt?: string;
  emailSentTo?: string;
  onEmailToChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
}

export function InvoiceEmailModal({
  open,
  invoiceNumber,
  emailTo,
  emailSending,
  emailSuccess,
  emailSentAt,
  emailSentTo,
  onEmailToChange,
  onSend,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] shadow-2xl w-full max-w-md mx-4 p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Email Invoice</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
          Send invoice <strong>{invoiceNumber}</strong> as a PDF attachment.
        </p>
        <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
          Recipient Email
        </label>
        <input
          type="email"
          value={emailTo}
          onChange={e => onEmailToChange(e.target.value)}
          placeholder="client@example.com"
          className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/50 mb-4"
        />
        {emailSuccess && (
          <div
            className={`flex items-center gap-2 p-3 rounded-lg text-sm mb-4 ${
              emailSuccess.includes('successfully')
                ? 'bg-teal-500/10 text-teal-400'
                : 'bg-amber-500/10 text-amber-400'
            }`}
          >
            {emailSuccess.includes('successfully')
              ? <CheckCircle2 className="h-4 w-4" />
              : <AlertCircle className="h-4 w-4" />}
            {emailSuccess}
          </div>
        )}
        {emailSentAt && (
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">
            Last sent to {emailSentTo} on {emailSentAt.split('T')[0]}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg border border-[var(--ff-border-light)]"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={emailSending || !emailTo.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-500 disabled:opacity-50"
          >
            {emailSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {emailSending ? 'Sending...' : 'Send Email'}
          </button>
        </div>
      </div>
    </div>
  );
}
