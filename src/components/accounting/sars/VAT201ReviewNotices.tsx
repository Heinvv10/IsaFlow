/**
 * What to look at before filing: classification calls the ledger cannot settle
 * (vat201SarsFields.buildVat201Warnings) and whether the return is filable at
 * all (evaluateVat201Filability). Neither blocks the page or the manual
 * mark-submitted action: the pre-filing exceptions below still own the gate.
 */
import { AlertTriangle } from 'lucide-react';
import type { Vat201FormWarning } from '@/modules/accounting/services/reports/vat201SarsFields';

interface Props {
  warnings: Vat201FormWarning[];
  filability: { filable: boolean; reason: string | null };
}

export function VAT201ReviewNotices({ warnings, filability }: Props) {
  const notices = [
    ...(filability.filable || !filability.reason ? [] : [{ key: 'filability', message: filability.reason }]),
    ...warnings.map((w) => ({ key: w.code, message: w.message })),
  ];
  if (notices.length === 0) return null;
  return (
    <div data-testid="vat201-review-notices" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 space-y-2">
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-400">
        <AlertTriangle className="h-4 w-4" /> Review before filing
      </p>
      <ul className="space-y-1 text-sm text-[var(--ff-text-secondary)] list-disc pl-5">
        {notices.map((n) => <li key={n.key} data-testid={`vat201-notice-${n.key}`}>{n.message}</li>)}
      </ul>
    </div>
  );
}
