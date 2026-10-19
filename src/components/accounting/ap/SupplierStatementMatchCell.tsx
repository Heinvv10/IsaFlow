/**
 * The "Match" cell of a supplier statement line: how the line was matched to an IsaFlow bill
 * (extracted from pages/accounting/ap/supplier-statements/[id].tsx to keep that page under 300 lines).
 */

export type MismatchReason = 'missing_in_isaflow' | 'missing_in_statement' | 'amount_diff' | 'date_diff' | null;

export interface StatementLine {
  matchConfidence: number | null;
  mismatchReason: MismatchReason;
}

export function MatchStatusCell({ line }: { line: StatementLine }) {
  const conf = line.matchConfidence ?? 0;
  if (line.mismatchReason === 'missing_in_isaflow') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-red-500/15 text-red-400 border-red-500/30">Missing in IsaFlow</span>
        <div className="relative group/tip">
          <button disabled className="text-xs text-[var(--ff-text-tertiary)] border border-[var(--ff-border-light)] px-2 py-0.5 rounded opacity-50 cursor-not-allowed">Create invoice</button>
          <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 px-2 py-1 rounded text-xs bg-gray-900 text-gray-200 whitespace-nowrap opacity-0 group-hover/tip:opacity-100 transition-opacity z-10">
            Phase 7 scope — create manually for now
          </span>
        </div>
      </div>
    );
  }
  if (line.mismatchReason === 'amount_diff') return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-amber-500/15 text-amber-400 border-amber-500/30">Amount diff</span>;
  if (line.mismatchReason === 'date_diff') return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-amber-500/15 text-amber-400 border-amber-500/30">Date diff</span>;
  if (conf >= 0.95) return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-teal-500/15 text-teal-400 border-teal-500/30">Matched</span>;
  if (conf >= 0.70) return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-amber-500/15 text-amber-400 border-amber-500/30">Fuzzy match</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-slate-600/30 text-slate-400 border-slate-500/30">Unmatched</span>;
}
