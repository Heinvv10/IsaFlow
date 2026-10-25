/**
 * Inline reason-collection form — replaces native window.prompt() for actions
 * that require a written reason (mark/unmark VAT declared elsewhere, link a
 * tax invoice to a journal). Textarea + Confirm/Cancel, styled to match
 * VatGateOverrideBox's override-reason box. Confirm stays disabled until the
 * trimmed reason is non-empty; onConfirm always receives the trimmed value.
 */
import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';

interface Props {
  label: string;
  placeholder?: string;
  busy?: boolean;
  confirmLabel?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export function InlineReasonForm({ label, placeholder, busy = false, confirmLabel = 'Confirm', onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState('');
  const id = useId();
  const trimmed = reason.trim();

  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] p-3 space-y-2">
      <label htmlFor={id} className="block text-xs font-medium text-[var(--ff-text-secondary)]">{label}</label>
      <textarea
        id={id}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        autoFocus
        disabled={busy}
        placeholder={placeholder}
        className="w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-xs text-[var(--ff-text-primary)]"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || trimmed === ''}
          onClick={() => onConfirm(trimmed)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />} {confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
