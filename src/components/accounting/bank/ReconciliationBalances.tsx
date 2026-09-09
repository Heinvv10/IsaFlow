/**
 * The four-figure header of the bank reconciliation screen.
 *
 * Extracted from pages/accounting/bank-reconciliation/[reconId].tsx so the
 * legacy-row warning below can be rendered in a test rather than grepped: it is
 * a conditional inside the tile and only a real render exercises it.
 */

import { CheckCircle2 } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import type { BankReconciliation } from '@/modules/accounting/types/bank.types';

const TILE =
  'p-4 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]';

export function ReconciliationBalances({ recon }: { recon: BankReconciliation }) {
  const balanced = Math.abs(recon.difference) < 0.01;
  // Rows written before the K-020 fix stored reconciled_balance as the GL balance
  // PLUS the matched amounts, so it is not the GL balance, and the difference is
  // derived from it. Say so rather than showing a tile that silently disagrees
  // with the difference beside it.
  const staleReconciled = Math.abs(recon.glBalance - recon.reconciledBalance) >= 0.01;

  return (
    // One ledger figure, not two: reconciled_balance IS the posted GL balance as
    // at the statement date, so a separate "Reconciled Balance" tile repeated it.
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      <div className={TILE}>
        <p className="text-xs text-[var(--ff-text-tertiary)]">Statement Balance</p>
        <p className="text-xl font-bold text-[var(--ff-text-primary)]">{formatCurrency(recon.statementBalance)}</p>
      </div>
      <div className={TILE}>
        <p className="text-xs text-[var(--ff-text-tertiary)]">GL Balance (as at statement date)</p>
        <p className="text-xl font-bold text-blue-400">{formatCurrency(recon.glBalance)}</p>
        {staleReconciled && (
          <p className="text-xs text-amber-400 mt-1">
            Stored reconciled balance {formatCurrency(recon.reconciledBalance)} predates the balance
            fix; the difference is still derived from it. Post an adjustment to recompute.
          </p>
        )}
      </div>
      <div className={`p-4 rounded-lg border ${balanced ? 'bg-teal-500/10 border-teal-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
        <p className="text-xs text-[var(--ff-text-tertiary)]">Difference</p>
        <p className={`text-xl font-bold ${balanced ? 'text-teal-400' : 'text-red-400'}`}>
          {formatCurrency(recon.difference)}
        </p>
        {balanced && (
          <p className="text-xs text-teal-400 flex items-center gap-1 mt-1">
            <CheckCircle2 className="h-3 w-3" /> Balanced
          </p>
        )}
      </div>
    </div>
  );
}
