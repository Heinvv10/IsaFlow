import { AlertCircle, Scale } from 'lucide-react';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Totals {
  consolidatedDebit: number;
  consolidatedCredit: number;
}

interface Props {
  totals: Totals;
  consolidatedBalanced: boolean;
}

export function TBSummaryCards({ totals, consolidatedBalanced }: Props) {
  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Consolidated Debits</p>
        <p className="text-xl font-bold text-[var(--ff-text-primary)]">{fmt(totals.consolidatedDebit)}</p>
      </div>
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Consolidated Credits</p>
        <p className="text-xl font-bold text-[var(--ff-text-primary)]">{fmt(totals.consolidatedCredit)}</p>
      </div>
      <div className={`rounded-lg border p-4 ${consolidatedBalanced ? 'bg-teal-500/5 border-teal-500/30' : 'bg-red-500/5 border-red-500/30'}`}>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Difference</p>
        <p className={`text-xl font-bold ${consolidatedBalanced ? 'text-teal-400' : 'text-red-400'}`}>
          {fmt(Math.abs(totals.consolidatedDebit - totals.consolidatedCredit))}
          <span className="text-sm ml-2">{consolidatedBalanced ? 'Balanced' : 'Out of Balance'}</span>
        </p>
      </div>
    </div>
  );
}

interface FooterProps {
  totals: Totals;
  consolidatedBalanced: boolean;
  hasUnmapped: boolean;
  hasEliminations: boolean;
}

export function TBBalanceFooter({ totals, consolidatedBalanced, hasUnmapped, hasEliminations }: FooterProps) {
  return (
    <div className="mt-4 flex items-center gap-4 text-sm flex-wrap">
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg ${consolidatedBalanced ? 'bg-teal-500/10 text-teal-400' : 'bg-red-500/10 text-red-400'}`}>
        {consolidatedBalanced ? <Scale className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
        {consolidatedBalanced
          ? 'Consolidated trial balance is in balance'
          : `Out of balance by ${fmt(Math.abs(totals.consolidatedDebit - totals.consolidatedCredit))}`}
      </div>
      {hasUnmapped && (
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400">
          <AlertCircle className="h-4 w-4" />
          Unmapped accounts detected — review group account mappings
        </div>
      )}
      {hasEliminations && (
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-400">
          <Scale className="h-4 w-4" />
          Rows with elimination entries highlighted in amber
        </div>
      )}
    </div>
  );
}
