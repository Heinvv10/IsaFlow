/**
 * Fiscal Periods Tab — period management with open/close/lock/reopen actions
 */

import { useState, useEffect } from 'react';
import { Loader2, Plus, Calendar, ClipboardCheck } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';
import { CloseReadinessChecklist } from '@/components/accounting/fiscal-periods/CloseReadinessChecklist';
import { CreateYearModal } from '@/components/accounting/fiscal-periods/CreateYearModal';
import { BulkConfirmModal, type BulkAction } from '@/components/accounting/fiscal-periods/BulkConfirmModal';
import { statusIcon, statusBadge } from '@/components/accounting/fiscal-periods/statusVisuals';

const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export function FiscalPeriodsTab() {
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<BulkAction | null>(null);
  const [bulkResult, setBulkResult] = useState<{ ok: number; total: number; failures: Array<{ id: string; error: string }> } | null>(null);

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

  const handleBulkAction = async (action: BulkAction) => {
    const ids = [...checked];
    if (ids.length === 0) return;
    setBulkBusy(action); setBulkResult(null);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action, ids }),
      });
      const json = await res.json() as { data?: { results: Array<{ id: string; ok: boolean; error?: string }>; okCount: number; total: number }; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message || 'Bulk action failed');
      const data = json.data!;
      setBulkResult({
        ok: data.okCount,
        total: data.total,
        failures: data.results.filter(r => !r.ok).map(r => ({ id: r.id, error: r.error || 'Unknown error' })),
      });
      setChecked(new Set());
      await loadPeriods();
    } catch (err) {
      log.error('Bulk fiscal period action failed', { error: err, action }, 'accounting-ui');
      // Network/server error: the server may have processed some periods
      // before the connection broke. Reload to surface whatever did land,
      // and tell the user the count is best-effort.
      const msg = err instanceof Error ? err.message : 'Failed';
      setBulkResult({
        ok: 0,
        total: ids.length,
        failures: ids.map(id => ({ id, error: `${msg} — partial success possible, list reloaded` })),
      });
      await loadPeriods();
    } finally { setBulkBusy(null); }
  };

  const toggleAll = (visiblePeriods: FiscalPeriod[]) => {
    const allIds = visiblePeriods.map(p => p.id);
    const allChecked = allIds.every(id => checked.has(id));
    setChecked(allChecked ? new Set() : new Set(allIds));
  };

  const toggleOne = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handlePeriodAction = async (periodId: string, action: 'close' | 'lock' | 'reopen') => {
    setActionLoading(periodId);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ id: periodId, action }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: { message?: string }; message?: string };
        throw new Error(body.error?.message || body.message || 'Action failed');
      }
      await loadPeriods();
    } catch (err) {
      log.error('Fiscal period action failed', { error: err, periodId, action }, 'accounting-ui');
    } finally { setActionLoading(null); }
  };

  const selectedPeriod = selectedPeriodId
    ? (periods.find(p => p.id === selectedPeriodId) ?? null)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {periods.length} period{periods.length !== 1 ? 's' : ''} across {[...new Set(periods.map(p => p.fiscalYear))].length} year{[...new Set(periods.map(p => p.fiscalYear))].length !== 1 ? 's' : ''}
          {checked.size > 0 && <span className="ml-2 text-teal-500 font-medium">· {checked.size} selected</span>}
        </p>
        <div className="flex items-center gap-2">
          {checked.size > 0 && (
            <>
              <button
                onClick={() => setBulkConfirm('bulk_reopen')}
                disabled={bulkBusy !== null}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors disabled:opacity-40"
              >
                Reopen ({checked.size})
              </button>
              <button
                onClick={() => setBulkConfirm('bulk_close')}
                disabled={bulkBusy !== null}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors disabled:opacity-40"
              >
                Close ({checked.size})
              </button>
              <button
                onClick={() => setBulkConfirm('bulk_lock')}
                disabled={bulkBusy !== null}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors disabled:opacity-40"
              >
                Lock ({checked.size})
              </button>
              <button
                onClick={() => setChecked(new Set())}
                className="px-2 py-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                Clear
              </button>
              <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />
            </>
          )}
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 px-3 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold transition-colors shadow-sm shadow-amber-500/20">
            <Plus className="h-3.5 w-3.5" /> Create Fiscal Year
          </button>
        </div>
      </div>

      {bulkResult && (
        <div className={`p-3 rounded-lg text-sm ${bulkResult.failures.length === 0 ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'}`}>
          <div className="flex items-center justify-between">
            <span>
              {bulkResult.ok} of {bulkResult.total} period{bulkResult.total !== 1 ? 's' : ''} updated
              {bulkResult.failures.length > 0 && ` · ${bulkResult.failures.length} failed`}
            </span>
            <button onClick={() => setBulkResult(null)} className="text-xs underline opacity-70 hover:opacity-100">Dismiss</button>
          </div>
          {bulkResult.failures.length > 0 && (
            <ul className="mt-2 text-xs space-y-1 list-disc list-inside opacity-90">
              {bulkResult.failures.slice(0, 5).map(f => (
                <li key={f.id}>{periods.find(p => p.id === f.id)?.periodName ?? f.id}: {f.error}</li>
              ))}
              {bulkResult.failures.length > 5 && <li>… and {bulkResult.failures.length - 5} more</li>}
            </ul>
          )}
        </div>
      )}

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
                <th className="pl-5 pr-2 py-3 w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all periods"
                    checked={periods.length > 0 && periods.every(p => checked.has(p.id))}
                    ref={el => { if (el) el.indeterminate = checked.size > 0 && checked.size < periods.length; }}
                    onChange={() => toggleAll(periods)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-teal-600 focus:ring-teal-500 cursor-pointer"
                  />
                </th>
                {['Period', 'Year', 'Start Date', 'End Date', 'Status', 'Actions'].map((h, i) => (
                  <th key={h} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 5 ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {periods.map(period => {
                // String compare on YYYY-MM-DD avoids the UTC-midnight TZ skew
                // that would mis-flag a today-starting period as "Future" before 02:00 SAST.
                const isFuture = String(period.startDate).slice(0, 10) > new Date().toISOString().slice(0, 10);
                return (
                <tr
                  key={period.id}
                  className={`transition-colors cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/30 ${selectedPeriodId === period.id ? 'bg-teal-50/50 dark:bg-teal-900/10' : ''} ${checked.has(period.id) ? 'bg-teal-50/30 dark:bg-teal-900/5' : ''}`}
                  onClick={() => setSelectedPeriodId(prev => prev === period.id ? null : period.id)}
                >
                  <td className="pl-5 pr-2 py-3.5" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${period.periodName}`}
                      checked={checked.has(period.id)}
                      onChange={() => toggleOne(period.id)}
                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-teal-600 focus:ring-teal-500 cursor-pointer"
                    />
                  </td>
                  <td className="px-5 py-3.5 font-medium text-slate-900 dark:text-slate-100">
                    <div className="flex items-center gap-2">
                      {selectedPeriodId === period.id && (
                        <ClipboardCheck className="h-3.5 w-3.5 text-teal-500 flex-shrink-0" />
                      )}
                      {period.periodName}
                      {isFuture && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">Future</span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{period.fiscalYear}</td>
                  <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{new Date(period.startDate).toLocaleDateString('en-ZA')}</td>
                  <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{new Date(period.endDate).toLocaleDateString('en-ZA')}</td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${statusBadge(period.status)}`}>
                      {statusIcon(period.status)}{period.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
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
                      {period.status === 'locked' && <span className="text-xs text-slate-500 dark:text-slate-400">Locked</span>}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedPeriod && (
        <CloseReadinessChecklist
          periodId={selectedPeriod.id}
          periodName={selectedPeriod.periodName}
        />
      )}

      {!selectedPeriod && !isLoading && periods.length > 0 && (
        <p className="text-xs text-center text-slate-400 dark:text-slate-500">
          Click a period row to view its close-readiness checklist.
        </p>
      )}

      {showCreate && <CreateYearModal onClose={() => setShowCreate(false)} onCreated={loadPeriods} />}

      {bulkConfirm && (
        <BulkConfirmModal
          action={bulkConfirm}
          count={checked.size}
          busy={bulkBusy === bulkConfirm}
          onCancel={() => setBulkConfirm(null)}
          onConfirm={async () => {
            const action = bulkConfirm;
            setBulkConfirm(null);
            await handleBulkAction(action);
          }}
        />
      )}
    </div>
  );
}

