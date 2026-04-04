/**
 * Fiscal Periods Tab — period management with open/close/lock/reopen actions
 */

import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, Clock, Lock } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';

function statusIcon(status: string): React.ReactNode {
  switch (status) {
    case 'open':    return <CheckCircle2 className="h-4 w-4 text-teal-500" />;
    case 'closing': return <Clock className="h-4 w-4 text-amber-500" />;
    case 'closed':  return <Lock className="h-4 w-4 text-blue-500" />;
    case 'locked':  return <Lock className="h-4 w-4 text-red-500" />;
    default:        return null;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'open':    return 'bg-teal-500/20 text-teal-400';
    case 'closing': return 'bg-amber-500/20 text-amber-400';
    case 'closed':  return 'bg-blue-500/20 text-blue-400';
    case 'locked':  return 'bg-red-500/20 text-red-400';
    default:        return 'bg-gray-500/20 text-gray-400';
  }
}

export function FiscalPeriodsTab() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => { loadPeriods(); }, []);

  const loadPeriods = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods');
      const data = await res.json();
      setPeriods(data.data || data || []);
    } catch (err) {
      log.error('Failed to load fiscal periods', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePeriodAction = async (periodId: string, action: 'close' | 'lock' | 'reopen') => {
    setActionLoading(periodId);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: periodId, action }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Action failed');
      }
      await loadPeriods();
    } catch (err) {
      log.error('Fiscal period action failed', { error: err, periodId, action }, 'accounting-ui');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                  {['Period', 'Year', 'Start Date', 'End Date', 'Status', 'Actions'].map((h, i) => (
                    <th key={h} className={`px-6 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] ${i === 5 ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {periods.map(period => (
                  <tr key={period.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                    <td className="px-6 py-3 text-sm font-medium text-[var(--ff-text-primary)]">{period.periodName}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-secondary)]">{period.fiscalYear}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">{new Date(period.startDate).toLocaleDateString()}</td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">{new Date(period.endDate).toLocaleDateString()}</td>
                    <td className="px-6 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium uppercase ${statusColor(period.status)}`}>
                        {statusIcon(period.status)}
                        {period.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {period.status === 'open' && (
                          <button
                            onClick={() => handlePeriodAction(period.id, 'close')}
                            disabled={actionLoading === period.id}
                            className="px-3 py-1 text-xs font-medium rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === period.id ? 'Closing...' : 'Close'}
                          </button>
                        )}
                        {period.status === 'closed' && (
                          <>
                            <button
                              onClick={() => handlePeriodAction(period.id, 'lock')}
                              disabled={actionLoading === period.id}
                              className="px-3 py-1 text-xs font-medium rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                            >
                              Lock
                            </button>
                            <button
                              onClick={() => handlePeriodAction(period.id, 'reopen')}
                              disabled={actionLoading === period.id}
                              className="px-3 py-1 text-xs font-medium rounded bg-teal-500/20 text-teal-400 hover:bg-teal-500/30 transition-colors disabled:opacity-50"
                            >
                              Reopen
                            </button>
                          </>
                        )}
                        {period.status === 'locked' && (
                          <span className="text-xs text-[var(--ff-text-tertiary)]">Locked</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
