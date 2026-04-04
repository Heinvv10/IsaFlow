/**
 * VAT201 Submit Modal — enter SARS eFiling reference number.
 */

import { Send, Loader2 } from 'lucide-react';

interface Props {
  sarsRef: string;
  submitting: boolean;
  onRefChange: (v: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function VAT201SubmitModal({ sarsRef, submitting, onRefChange, onConfirm, onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Mark as Submitted to SARS</h3>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
          Enter the SARS eFiling reference number after submitting the return on the SARS eFiling portal.
        </p>
        <input
          type="text"
          value={sarsRef}
          onChange={(e) => onRefChange(e.target.value)}
          placeholder="SARS reference number"
          className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm mb-4"
        />
        <div className="flex items-center gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting || !sarsRef.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
