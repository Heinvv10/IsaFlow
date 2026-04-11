/**
 * Financial Years — year summary card with expandable period table
 */
import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Calendar, Lock, AlertTriangle, Loader2 } from 'lucide-react';
import type { FiscalYearGroup } from './types';
import { PeriodRow } from './PeriodRow';

interface Props {
  group: FiscalYearGroup;
  jeCounts: Record<string, number>;
  loadingId: string | null;
  onPeriodAction: (id: string, action: 'close' | 'lock' | 'reopen') => void;
  onCloseYear: (year: number) => void;
  closingYear: number | null;
}

const YEAR_STATUS_STYLES = {
  open:   'bg-teal-500/10 text-teal-400 border border-teal-500/30',
  closed: 'bg-blue-500/10 text-blue-400 border border-blue-500/30',
  mixed:  'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30',
};

export function YearCard({ group, jeCounts, loadingId, onPeriodAction, onCloseYear, closingYear }: Props) {
  const [expanded, setExpanded] = useState(true);
  const isClosingThisYear = closingYear === group.year;

  const handleCloseYear = useCallback(() => {
    onCloseYear(group.year);
  }, [group.year, onCloseYear]);

  const canCloseYear = group.status !== 'closed' && group.periods.some(p => p.status === 'open' || p.status === 'closing');

  return (
    <div className="border border-[var(--ff-border-primary)] rounded-xl overflow-hidden">
      {/* Year header */}
      <div className="bg-[var(--ff-bg-secondary)] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => setExpanded(e => !e)}
            className="text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <div className="p-1.5 rounded-md bg-teal-500/10"><Calendar className="h-4 w-4 text-teal-500" /></div>
          <div>
            <h3 className="font-semibold text-[var(--ff-text-primary)]">{group.label}</h3>
            <p className="text-xs text-[var(--ff-text-secondary)]">
              {group.periods.length} periods &middot; {group.lockedCount} locked &middot; {group.closedCount} closed
            </p>
          </div>
          <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium capitalize ${YEAR_STATUS_STYLES[group.status]}`}>
            {group.status}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {canCloseYear && (
            <button onClick={handleCloseYear} disabled={isClosingThisYear}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border border-blue-500/30 transition-colors disabled:opacity-50">
              {isClosingThisYear ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lock className="h-3 w-3" />}
              Close Year
            </button>
          )}
        </div>
      </div>

      {/* Periods table */}
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] text-xs uppercase tracking-wider">
                <th className="pl-12 pr-4 py-2 text-left font-medium">Period</th>
                <th className="px-4 py-2 text-left font-medium">Start Date</th>
                <th className="px-4 py-2 text-left font-medium">End Date</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Journal Entries</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {group.periods.map(p => (
                <PeriodRow key={p.id} period={p} jeCount={jeCounts[p.id] ?? 0}
                  loadingId={loadingId} onAction={onPeriodAction} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Locked year banner */}
      {group.status === 'closed' && group.lockedCount === group.periods.length && (
        <div className="px-4 py-2 bg-slate-900/40 border-t border-[var(--ff-border-primary)] flex items-center gap-2 text-xs text-slate-400">
          <Lock className="h-3 w-3" /> All periods locked — year is fully closed
        </div>
      )}
      {group.status === 'mixed' && (
        <div className="px-4 py-2 bg-yellow-900/20 border-t border-yellow-500/20 flex items-center gap-2 text-xs text-yellow-500">
          <AlertTriangle className="h-3 w-3" /> Some periods are still open
        </div>
      )}
    </div>
  );
}
