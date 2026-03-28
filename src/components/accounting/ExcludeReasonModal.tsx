/**
 * ExcludeReasonModal
 * Small modal overlay for capturing a reason when excluding a bank transaction.
 * Preset reason buttons reduce friction; free-text notes allow custom context.
 */

import { useState } from 'react';
import { X } from 'lucide-react';

/** Preset exclusion reasons shown as quick-select buttons */
const PRESET_REASONS = [
  'Duplicate',
  'Personal/Non-business',
  'Bank Fee (already captured)',
  'Transfer Between Own Accounts',
  'Other',
] as const;

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}

export interface ExcludeReasonModalTransaction {
  id: string;
  description?: string;
  amount: number;
}

interface Props {
  transaction: ExcludeReasonModalTransaction;
  onClose: () => void;
  /** Called when the user confirms exclusion. reason is always non-empty. */
  onExclude: (reason: string, notes?: string) => void;
}

/** 🟢 WORKING: Modal to capture exclusion reason before excluding a bank transaction */
export function ExcludeReasonModal({ transaction, onClose, onExclude }: Props) {
  const [selectedReason, setSelectedReason] = useState<string>('');
  const [customReason, setCustomReason] = useState('');
  const [notes, setNotes] = useState('');

  const activeReason = selectedReason === 'Other' ? customReason.trim() : selectedReason;
  const canConfirm = Boolean(activeReason);

  function handleConfirm() {
    if (!canConfirm) return;
    onExclude(activeReason, notes.trim() || undefined);
  }

  function handlePreset(reason: string) {
    setSelectedReason(reason);
    if (reason !== 'Other') setCustomReason('');
  }

  const spent = transaction.amount < 0 ? Math.abs(transaction.amount) : null;
  const received = transaction.amount > 0 ? transaction.amount : null;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      {/* Panel — stop propagation so clicking inside doesn't close */}
      <div
        className="relative w-full max-w-md rounded-xl border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] shadow-2xl p-6 mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">
              Exclude Transaction
            </h2>
            <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5 line-clamp-1 max-w-[300px]">
              {transaction.description || 'No description'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Amount pill */}
        <div className="mb-5 flex gap-2">
          {spent !== null && (
            <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-red-500/10 text-red-400">
              Spent {fmtCurrency(spent)}
            </span>
          )}
          {received !== null && (
            <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-400">
              Received {fmtCurrency(received)}
            </span>
          )}
        </div>

        {/* Preset reason buttons */}
        <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-2">
          Reason for exclusion
        </p>
        <div className="flex flex-wrap gap-2 mb-4">
          {PRESET_REASONS.map(reason => (
            <button
              key={reason}
              onClick={() => handlePreset(reason)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                selectedReason === reason
                  ? 'border-red-500 bg-red-500/15 text-red-400 font-medium'
                  : 'border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:border-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]'
              }`}
            >
              {reason}
            </button>
          ))}
        </div>

        {/* Custom reason input — shown when "Other" is selected */}
        {selectedReason === 'Other' && (
          <input
            type="text"
            placeholder="Describe the reason..."
            value={customReason}
            onChange={e => setCustomReason(e.target.value)}
            maxLength={200}
            autoFocus
            className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-primary)] placeholder-[var(--ff-text-tertiary)] focus:outline-none focus:border-red-500 mb-4"
          />
        )}

        {/* Optional notes textarea */}
        <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-1.5">
          Additional notes{' '}
          <span className="text-[var(--ff-text-tertiary)] font-normal">(optional)</span>
        </p>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Any additional context..."
          rows={2}
          maxLength={500}
          className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-primary)] placeholder-[var(--ff-text-tertiary)] focus:outline-none focus:border-[var(--ff-text-tertiary)] resize-none mb-5"
        />

        {/* Action buttons */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
          >
            Exclude Transaction
          </button>
        </div>
      </div>
    </div>
  );
}
