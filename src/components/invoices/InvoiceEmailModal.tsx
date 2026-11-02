/**
 * InvoiceEmailModal — Send invoice by email. A modal dialog: focus moves in and stays (useFocusTrap), Escape and the
 * backdrop close it, except while a send is out: then nothing closes it and Send waits. Send stays off once the
 * invoice was emailed (reopen the form to send again).
 */

import { useId, useRef } from 'react';
import { Loader2, Send, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { formatDisplayDate } from '@/utils/dateFormat';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

interface Props {
  open: boolean;
  invoiceNumber: string;
  emailTo: string;
  emailSending: boolean;
  emailSuccess: string;
  emailSentAt?: string;
  emailSentTo?: string;
  /** A line above the address, e.g. that the invoice was just approved and is not sent yet. */
  notice?: string;
  onEmailToChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
}

export function InvoiceEmailModal(props: Props) {
  return props.open ? <EmailDialog {...props} /> : null;
}

function EmailDialog({
  invoiceNumber,
  emailTo,
  emailSending,
  emailSuccess,
  emailSentAt,
  emailSentTo,
  notice,
  onEmailToChange,
  onSend,
  onClose,
}: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const inputId = useId();
  const sent = emailSuccess.includes('successfully');
  const close = () => { if (!emailSending) onClose(); };
  useFocusTrap(dialog, true, close);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={close}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] shadow-2xl w-full max-w-md mx-4 p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id={titleId} className="text-lg font-semibold text-[var(--ff-text-primary)]">Email Invoice</h3>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={close}
            disabled={emailSending}
            className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
          Send invoice <strong>{invoiceNumber}</strong> as a PDF attachment.
        </p>
        {notice && <p className="text-sm text-[var(--ff-text-secondary)] mb-4">{notice}</p>}
        <label htmlFor={inputId} className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
          Recipient Email
        </label>
        <input
          id={inputId}
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
            Last sent to {emailSentTo} on {formatDisplayDate(emailSentAt)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            disabled={emailSending}
            className="disabled:opacity-50 px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg border border-[var(--ff-border-light)]"
          >
            Close
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={emailSending || sent || !emailTo.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50"
          >
            {emailSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {emailSending ? 'Sending...' : 'Send Email'}
          </button>
        </div>
      </div>
    </div>
  );
}
