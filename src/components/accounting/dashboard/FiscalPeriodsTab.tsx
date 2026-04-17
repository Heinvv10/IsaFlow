/**
 * Fiscal Periods Tab — period management with open/close/lock/reopen actions
 */

import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, Clock, Lock, Plus, Calendar, X } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';

const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

function statusIcon(status: string): React.ReactNode {
  switch (status) {
    case 'open':    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case 'closing': return <Clock className="h-3.5 w-3.5 text-amber-500" />;
    case 'closed':  return <Lock className="h-3.5 w-3.5 text-blue-500" />;
    case 'locked':  return <Lock className="h-3.5 w-3.5 text-red-500" />;
    default:        return null;
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case 'open':    return 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
    case 'closing': return 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400';
    case 'closed':  return 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400';
    case 'locked':  return 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400';
    default:        return 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400';
  }
}

function CreateYearModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    setSaving(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year }),
      });
      const json = await res.json() as { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message || 'Failed to create fiscal year');
      onCreated(); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-slate-950/80 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center"><Calendar className="w-4 h-4 text-amber-500" /></div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Create Fiscal Year</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Creates 12 monthly periods</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 rounded-lg text-sm">{error}</div>}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">Financial Year</label>
            <select value={year} onChange={e => setYear(Number(e.target.value))} className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors">
              {[currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map(y => (
                <option key={y} value={y}>{y} (Jan – Dec {y})</option>
              ))}
            </select>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">This will create 12 monthly periods for the selected calendar year, all set to <strong>open</strong> status.</p>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2 bg-slate-50/50 dark:bg-slate-800/20">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
          <button onClick={handleCreate} disabled={saving} className="px-5 py-2 text-sm font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
            {saving ? 'Creating…' : 'Create Year'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FiscalPeriodsTab() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => { void loadPeriods(); }, []);

  const loadPeriods = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods');
      const data = await res.json() as { data?: FiscalPeriod[] };
      setPeriods(data.data || []);
    } catch (err) {
      log.error('Failed to load fiscal periods', { error: err }, 'accounting-ui');
    } finally { setIsLoading(false); }
  };

  const handlePeriodAction = async (periodId: string, action: 'close' | 'lock' | 'reopen') => {
    setActionLoading(periodId);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ id: periodId, action }),
      });
      if (!res.ok) { const err = await res.json() as { message?: string }; throw new Error(err.message || 'Action failed'); }
      await loadPeriods();
    } catch (err) {
      log.error('Fiscal period action failed', { error: err, periodId, action }, 'accounting-ui');
    } finally { setActionLoading(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500 dark:text-slate-400">{periods.length} period{periods.length !== 1 ? 's' : ''} across {[...new Set(periods.map(p => p.fiscalYear))].length} year{[...new Set(periods.map(p => p.fiscalYear))].length !== 1 ? 's' : ''}</p>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 px-3 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold transition-colors shadow-sm shadow-amber-500/20">
          <Plus className="h-3.5 w-3.5" /> Create Fiscal Year
        </button>
      </div>

      <div className={`${card} overflow-hidden`}>
        {isLoading ? (
          <div className="p-12 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" /></div>
        ) : periods.length === 0 ? (
          <div className="p-16 text-center">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4"><Calendar className="w-7 h-7 text-slate-500 dark:text-slate-400" /></div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">No fiscal periods yet</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-xs mx-auto">Create a fiscal year to start tracking journal entries by period</p>
            <button onClick={() => setShowCreate(true)} className="mt-5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors">
              Create Fiscal Year
            </button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
              <tr>
                {['Period', 'Year', 'Start Date', 'End Date', 'Status', 'Actions'].map((h, i) => (
                  <th key={h} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 5 ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {periods.map(period => (
                <tr key={period.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                  <td className="px-5 py-3.5 font-medium text-slate-900 dark:text-slate-100">{period.periodName}</td>
                  <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{period.fiscalYear}</td>
                  <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{new Date(period.startDate).toLocaleDateString('en-ZA')}</td>
                  <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{new Date(period.endDate).toLocaleDateString('en-ZA')}</td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${statusBadge(period.status)}`}>
                      {statusIcon(period.status)}{period.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {period.status === 'open' && (
                        <button onClick={() => handlePeriodAction(period.id, 'close')} disabled={actionLoading === period.id}
                          className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors disabled:opacity-40">
                          {actionLoading === period.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Close'}
                        </button>
                      )}
                      {period.status === 'closed' && (<>
                        <button onClick={() => handlePeriodAction(period.id, 'lock')} disabled={actionLoading === period.id}
                          className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors disabled:opacity-40">Lock</button>
                        <button onClick={() => handlePeriodAction(period.id, 'reopen')} disabled={actionLoading === period.id}
                          className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors disabled:opacity-40">Reopen</button>
                      </>)}
                      {period.status === 'locked' && <span className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">Locked</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showCreate && <CreateYearModal onClose={() => setShowCreate(false)} onCreated={loadPeriods} />}
    </div>
  );
}
