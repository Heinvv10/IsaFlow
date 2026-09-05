/**
 * The balanced / out-of-balance banner. Shared so the balance-sheet page and
 * the statutory AFS Statement of Financial Position tell the reader the same
 * thing: a statement that does not balance must never render silently, least
 * of all the one that goes to a regulator.
 */
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { formatMoney } from '@/lib/format/money';

export function BalanceCheckBanner({ totalAssets, totalLiabilities, totalEquity }: {
  totalAssets: number; totalLiabilities: number; totalEquity: number;
}) {
  // The only arithmetic in the statement layer that is not a copied figure.
  // It is a CONTROL, not a statement figure: it is never presented as one of
  // the report's own numbers, and it exists to say whether A = L + E holds.
  const gap = Math.abs(totalAssets - (totalLiabilities + totalEquity));
  if (gap < 0.02) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">
        <CheckCircle2 className="h-4 w-4" /> Balance sheet is balanced (A = L + E)
      </div>
    );
  }
  if (totalAssets <= 0) return null;
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4" /> Out of balance by {formatMoney(gap, { cents: true, symbol: true })}
    </div>
  );
}
