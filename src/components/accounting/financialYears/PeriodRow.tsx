/**
 * Financial Years — single period row in the expandable table
 */
import { Lock, Unlock, RefreshCw, Loader2 } from 'lucide-react';
import type { FiscalPeriod, FiscalPeriodStatus } from '@/modules/accounting/types/gl.types';
import { formatDate } from './types';

interface Props {
  period: FiscalPeriod;
  jeCount: number;
  loadingId: string | null;
  onAction: (id: string, action: 'close' | 'lock' | 'reopen') => void;
}

const STATUS_STYLES: Record<FiscalPeriodStatus, string> = {
  open:    'bg-teal-500/10 text-teal-400 border border-teal-500/30',
  closing: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30',
  closed:  'bg-blue-500/10 text-blue-400 border border-blue-500/30',
  locked:  'bg-slate-500/10 text-slate-400 border border-slate-500/30',
};

export function PeriodRow({ period, jeCount, loadingId, onAction }: Props) {
  const isLoading = loadingId === period.id;
  const isLocked = period.status === 'locked';

  return (
    <tr className={`border-b border-[var(--ff-border-primary)] text-sm transition-colors ${
      isLocked ? 'bg-slate-900/30' : 'hover:bg-[var(--ff-bg-hover)]'
    }`}>
      <td className="pl-12 pr-4 py-3 text-[var(--ff-text-primary)] flex items-center gap-2">
        {isLocked && <Lock className="h-3 w-3 text-slate-400 shrink-0" />}
        {period.periodName}
      </td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatDate(period.startDate)}</td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatDate(period.endDate)}</td>
      <td className="px-4 py-3">
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLES[period.status]}`}>
          {period.status}
        </span>
      </td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-right">{jeCount}</td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-teal-500" />
          ) : (
            <>
              {period.status === 'open' && (
                <button onClick={() => onAction(period.id, 'close')}
                  className="px-2 py-1 text-xs rounded bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 transition-colors">
                  Close
                </button>
              )}
              {period.status === 'closed' && (
                <>
                  <button onClick={() => onAction(period.id, 'lock')}
                    className="px-2 py-1 text-xs rounded bg-slate-600/20 hover:bg-slate-600/40 text-slate-400 transition-colors flex items-center gap-1">
                    <Lock className="h-3 w-3" /> Lock
                  </button>
                  <button onClick={() => onAction(period.id, 'reopen')}
                    className="px-2 py-1 text-xs rounded bg-teal-600/20 hover:bg-teal-600/40 text-teal-400 transition-colors flex items-center gap-1">
                    <RefreshCw className="h-3 w-3" /> Reopen
                  </button>
                </>
              )}
              {isLocked && (
                <span className="px-2 py-1 text-xs text-slate-500 flex items-center gap-1">
                  <Unlock className="h-3 w-3" /> Locked
                </span>
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
