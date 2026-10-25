/**
 * VAT201 Submit Modal — enter SARS eFiling reference number.
 *
 * Item 5 (VAT-gaps): the manual mark-submitted action has the SAME
 * blocking-exceptions gate as lock_vat_period (vatGateOverrideService), but
 * previously had no UI at all — a blocked call just showed the server's
 * refusal text with no way to proceed. `blockingCounts` (from the route's
 * 400 `error.details.counts`) renders the same VatGateOverrideBox
 * lock_vat_period uses; an owner/admin sees the exception list AND a
 * required-reason box and can retry with it; anyone else sees the refusal
 * only, with no way to override.
 */
import { Send, Loader2 } from 'lucide-react';
import { VatGateOverrideBox, type VatGateCounts } from './VatGateOverrideBox';

interface Props {
  sarsRef: string;
  submitting: boolean;
  onRefChange: (v: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  /** Set after a 400 refusal carrying getVatExceptions' blocking counts. */
  blockingCounts?: VatGateCounts | null;
  isOwnerOrAdmin?: boolean;
  overrideReason?: string;
  onOverrideReasonChange?: (reason: string) => void;
  /** Why the return fails the form's own arithmetic (evaluateVat201Filability). A warning only: marking it submitted stays allowed. */
  filabilityWarning?: string | null;
}

export function VAT201SubmitModal({
  sarsRef, submitting, onRefChange, onConfirm, onClose,
  blockingCounts = null, isOwnerOrAdmin = false, overrideReason = '', onOverrideReasonChange, filabilityWarning = null,
}: Props) {
  const blocked = blockingCounts !== null && blockingCounts.totalExceptions > 0;
  const needsReason = blocked && isOwnerOrAdmin && !overrideReason.trim();
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Mark as Submitted to SARS</h3>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
          Enter the SARS eFiling reference number after submitting the return on the SARS eFiling portal.
        </p>
        {filabilityWarning && (
          <p data-testid="vat201-submit-filability-warning" className="text-sm text-amber-400 mb-4">
            Warning: {filabilityWarning}
          </p>
        )}
        <input
          type="text"
          value={sarsRef}
          onChange={(e) => onRefChange(e.target.value)}
          placeholder="SARS reference number"
          className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm mb-4"
        />
        {blocked && (
          <VatGateOverrideBox
            counts={blockingCounts}
            isOwnerOrAdmin={isOwnerOrAdmin}
            reason={overrideReason}
            onReasonChange={(r) => onOverrideReasonChange?.(r)}
          />
        )}
        <div className="flex items-center gap-3 justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting || !sarsRef.trim() || (blocked && !isOwnerOrAdmin) || needsReason}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-success-700 text-white text-sm font-medium hover:bg-success-800 disabled:opacity-50">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {blocked && isOwnerOrAdmin ? 'Override and confirm' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
