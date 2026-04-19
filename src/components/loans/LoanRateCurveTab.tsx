/**
 * LoanRateCurveTab — shows rate curve name and its points for a specific loan.
 */

import { Loader2, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { RateCurve, RatePoint, fmtDate, fmtPct } from './types';

interface Props {
  curve: RateCurve | null;
  points: RatePoint[];
  loading: boolean;
}

export function LoanRateCurveTab({ curve, points, loading }: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-[var(--ff-text-tertiary)]">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading rate curve…
      </div>
    );
  }

  if (!curve) {
    return (
      <div className="py-8 text-center text-[var(--ff-text-tertiary)] text-sm">
        No rate curve linked to this loan. Rate curves apply to Prime-linked loans only.
      </div>
    );
  }

  const sorted = [...points].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">{curve.name}</h3>
          <p className="text-sm text-[var(--ff-text-secondary)]">{sorted.length} rate point{sorted.length !== 1 ? 's' : ''}</p>
        </div>
        <Link
          href="/accounting/loans/rate-curves"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:text-[var(--ff-text-primary)] text-xs"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Manage Curves
        </Link>
      </div>

      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
              <th className="px-4 py-3">Effective Date</th>
              <th className="px-4 py-3 text-right">Rate</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                  No rate points defined for this curve.
                </td>
              </tr>
            )}
            {sorted.map((pt, i) => (
              <tr key={i} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                <td className="px-4 py-3 text-[var(--ff-text-primary)]">{fmtDate(pt.effectiveDate)}</td>
                <td className="px-4 py-3 text-right text-teal-400 font-medium">{fmtPct(pt.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
