/**
 * Blocking VAT exceptions notice + owner/admin override reason box, shown
 * beside the "lock a period" form (and reusable anywhere else the
 * vatGateOverrideService gate applies — the manual mark-submitted action).
 *
 * `isOwnerOrAdmin` decides ONLY whether the reason field is offered; the
 * server (assertVatGateClear) is the actual gate and refuses a reason from
 * anyone else with a 403 regardless of what this component renders.
 */
import { AlertTriangle } from 'lucide-react';

export interface VatGateCounts {
  totalExceptions: number;
  uncodedGlLineCount?: number;
  invoiceTaxCodeIssueCount?: number;
  invoiceGlMismatchCount?: number;
  vatOnBalanceSheetCount?: number;
  vatNonSupplyCount?: number;
  unpostedInvoiceVatCount?: number;
  unsupportedInputVatCount?: number;
}

interface Props {
  counts: VatGateCounts | null;
  isOwnerOrAdmin: boolean;
  reason: string;
  onReasonChange: (reason: string) => void;
  exceptionsHref?: string;
}

// unsupportedInputVatCount is deliberately absent (Hein, 2026-09-26): it no
// longer contributes to totalExceptions, so listing it here as a cause of a
// "blocking VAT exception" would misrepresent it — it stays visible in the
// exceptions panel instead.
const LABELS: Array<[keyof VatGateCounts, string]> = [
  ['unpostedInvoiceVatCount', 'unposted invoice/bill VAT'],
  ['uncodedGlLineCount', 'uncoded GL VAT lines'],
  ['invoiceTaxCodeIssueCount', 'invoice tax-code issues'],
  ['invoiceGlMismatchCount', 'invoice ↔ GL VAT mismatches'],
  ['vatOnBalanceSheetCount', 'VAT on a balance-sheet account'],
  ['vatNonSupplyCount', 'VAT on a non-supply account'],
];

export function VatGateOverrideBox({ counts, isOwnerOrAdmin, reason, onReasonChange, exceptionsHref }: Props) {
  if (!counts || counts.totalExceptions <= 0) return null;

  return (
    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-500">
            {counts.totalExceptions} blocking VAT exception{counts.totalExceptions === 1 ? '' : 's'} for this period
          </p>
          <ul className="mt-1 list-disc pl-4 text-xs text-[var(--ff-text-secondary)]">
            {LABELS.filter(([key]) => (counts[key] ?? 0) > 0).map(([key, label]) => (
              <li key={key}>{counts[key]} {label}</li>
            ))}
          </ul>
          {exceptionsHref && (
            <a href={exceptionsHref} className="mt-1 inline-block text-xs text-teal-500 underline">
              View the exceptions panel
            </a>
          )}
        </div>
      </div>

      {isOwnerOrAdmin ? (
        <div className="mt-3">
          <label htmlFor="vat-gate-override-reason" className="block text-xs font-medium text-[var(--ff-text-secondary)]">
            Override reason (required to proceed with exceptions outstanding)
          </label>
          <textarea
            id="vat-gate-override-reason"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]"
            placeholder="Why this may proceed with exceptions outstanding"
          />
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--ff-text-secondary)]">
          Only an owner or admin can override blocking VAT exceptions.
        </p>
      )}
    </div>
  );
}
