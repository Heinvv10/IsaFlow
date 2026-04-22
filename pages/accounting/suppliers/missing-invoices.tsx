/**
 * Missing Invoices — PRD-05 Phase 6
 * Invoices the system expected but has not received yet. Chase or resolve.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2, Mail, MessageSquare, X, CheckCircle2, Clock, Search, FileQuestion, Zap } from 'lucide-react';
import { MissingInvoiceModals, type ExpectedAlert } from '@/components/accounting/suppliers/MissingInvoiceModals';

type StatusFilter = 'pending' | 'chased' | 'resolved' | 'dismissed';
type Toast = { msg: string; kind: 'ok' | 'err' | 'warn' } | null;
interface ChaseSettings { chaseAutoSendEnabled: boolean; chaseGraceDays: number; whatsappChaseEnabled: boolean; }

export const fmtZAR = (n: number | null) =>
  n == null ? '—' : 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (s: string | Date | null) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
};

function DaysOverdueBadge({ d }: { d: number }) {
  const cls = d > 7 ? 'text-red-400' : d >= 3 ? 'text-amber-400' : 'text-[var(--ff-text-tertiary)]';
  return <span className={`text-xs font-medium ${cls}`}>{d}d</span>;
}

export default function MissingInvoicesPage() {
  const [alerts, setAlerts] = useState<ExpectedAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [search, setSearch] = useState('');
  const [detectingGaps, setDetectingGaps] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [chaseAlert, setChaseAlert] = useState<ExpectedAlert | null>(null);
  const [resolveAlert, setResolveAlert] = useState<ExpectedAlert | null>(null);
  const [dismissAlert, setDismissAlert] = useState<ExpectedAlert | null>(null);
  const [chaseSettings, setChaseSettings] = useState<ChaseSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/chase-settings');
      if (!res.ok) return;
      const json = await res.json() as { data?: ChaseSettings };
      if (json.data) setChaseSettings(json.data);
    } catch { /* silent — settings UI is optional */ }
  }, []);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const saveSettings = useCallback(async (patch: Partial<ChaseSettings>) => {
    setSavingSettings(true);
    try {
      const res = await apiFetch('/api/accounting/chase-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json() as { data?: ChaseSettings; error?: string };
      if (!res.ok) { setToast({ msg: json.error ?? 'Failed to save settings', kind: 'err' }); return; }
      if (json.data) setChaseSettings(json.data);
      setToast({ msg: 'Chase settings saved', kind: 'ok' });
    } catch { setToast({ msg: 'Network error saving settings', kind: 'err' }); }
    finally { setSavingSettings(false); }
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/accounting/expected-invoice-alerts?status=${statusFilter}`);
      const json = await res.json() as { data?: ExpectedAlert[]; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load alerts'); return; }
      setAlerts(Array.isArray(json.data) ? json.data : []);
    } catch { setError('Network error loading missing invoice alerts'); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const detectGaps = useCallback(async () => {
    setDetectingGaps(true);
    try {
      const res = await apiFetch('/api/accounting/expected-invoice-alerts/detect-gaps', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) { setToast({ msg: json.error ?? 'Gap detection failed', kind: 'err' }); return; }
      setToast({ msg: 'Gap detection complete', kind: 'ok' });
      void load();
    } catch { setToast({ msg: 'Network error during gap detection', kind: 'err' }); }
    finally { setDetectingGaps(false); }
  }, [load]);

  const filtered = alerts.filter(a =>
    !search || a.supplierName.toLowerCase().includes(search.toLowerCase())
  );

  const toastCls = toast?.kind === 'ok'
    ? 'bg-teal-900/80 text-teal-200 border-teal-700'
    : toast?.kind === 'warn'
    ? 'bg-amber-900/80 text-amber-200 border-amber-700'
    : 'bg-red-900/80 text-red-200 border-red-700';

  const TH = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--ff-text-tertiary)]';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Missing Invoices</h1>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-1 max-w-xl">
                Invoices the system expected but has not received yet. Chase or resolve.
              </p>
            </div>
            <button onClick={detectGaps} disabled={detectingGaps}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white transition-colors shrink-0">
              <Search className={`h-4 w-4 ${detectingGaps ? 'animate-spin' : ''}`} />
              Run gap detection now
            </button>
          </div>

          {chaseSettings && (
            <div className="mt-4 flex flex-wrap items-center gap-3 p-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/50">
              <Zap className="h-4 w-4 text-amber-400 shrink-0" />
              <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--ff-text-primary)]">
                <input
                  type="checkbox"
                  checked={chaseSettings.chaseAutoSendEnabled}
                  disabled={savingSettings}
                  onChange={e => saveSettings({ chaseAutoSendEnabled: e.target.checked })}
                  className="h-4 w-4 rounded border-[var(--ff-border-light)] accent-amber-500"
                />
                Auto-send chase emails for overdue alerts
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
                after
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={chaseSettings.chaseGraceDays}
                  disabled={savingSettings || !chaseSettings.chaseAutoSendEnabled}
                  onChange={e => saveSettings({ chaseGraceDays: Number(e.target.value) })}
                  className="w-16 px-2 py-1 rounded bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-center focus:outline-none focus:border-amber-500/50 disabled:opacity-50"
                />
                days overdue (daily cron)
              </label>
              {savingSettings && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />}
            </div>
          )}
        </div>

        <div className="px-6 py-4">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search supplier..."
                className="w-full pl-9 pr-3 py-2 rounded-lg text-sm bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] focus:outline-none focus:border-teal-500/50" />
            </div>
            {(['pending', 'chased', 'resolved', 'dismissed'] as StatusFilter[]).map(f => (
              <button key={f} onClick={() => setStatusFilter(f)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors capitalize ${statusFilter === f ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40' : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] hover:border-teal-500/40'}`}>
                {f}
              </button>
            ))}
            <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{filtered.length} alert{filtered.length !== 1 ? 's' : ''}</span>
          </div>

          {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-4"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}

          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-amber-400" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 px-8 max-w-2xl mx-auto">
              <FileQuestion className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3 opacity-40" />
              <p className="text-[var(--ff-text-secondary)] text-sm leading-relaxed">
                No pending missing invoices — the expectation engine has not flagged anything.
              </p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className={TH}>Supplier</th><th className={TH}>Expected by</th>
                    <th className={TH}>Expected amount</th><th className={TH}>Days overdue</th>
                    <th className={TH}>Status</th><th className={TH}>Chase target</th><th className={TH}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(a => (
                    <tr key={a.id} className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5 transition-colors">
                      <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)] text-xs">{a.supplierName}</td>
                      <td className="px-4 py-3 text-xs font-mono text-[var(--ff-text-secondary)]">{fmtDate(a.expectedBy)}</td>
                      <td className="px-4 py-3 text-xs font-mono text-[var(--ff-text-secondary)]">{fmtZAR(a.expectedAmount)}</td>
                      <td className="px-4 py-3"><DaysOverdueBadge d={a.daysOverdue} /></td>
                      <td className="px-4 py-3">
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] capitalize">{a.status}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--ff-text-secondary)]">{a.chaseToAddress ?? a.supplierEmail ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="relative group/tip">
                            <button onClick={() => a.supplierEmail ? setChaseAlert(a) : undefined}
                              disabled={!a.supplierEmail || a.status !== 'pending'}
                              className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                              <Mail className="h-3.5 w-3.5" />Email
                            </button>
                            {!a.supplierEmail && (
                              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded text-xs bg-gray-900 text-gray-200 whitespace-nowrap opacity-0 group-hover/tip:opacity-100 transition-opacity z-10">
                                No supplier email on file
                              </span>
                            )}
                          </div>
                          <div className="relative group/watip">
                            <button onClick={() => a.supplierWhatsappNumber ? setChaseAlert(a) : undefined}
                              disabled={!a.supplierWhatsappNumber || a.status !== 'pending'}
                              className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                              <MessageSquare className="h-3.5 w-3.5" />WA
                            </button>
                            {!a.supplierWhatsappNumber && (
                              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded text-xs bg-gray-900 text-gray-200 whitespace-nowrap opacity-0 group-hover/watip:opacity-100 transition-opacity z-10">
                                No WhatsApp number on file
                              </span>
                            )}
                          </div>
                          <button onClick={() => setResolveAlert(a)} disabled={a.status === 'resolved' || a.status === 'dismissed'}
                            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                            <CheckCircle2 className="h-3.5 w-3.5" />Resolve
                          </button>
                          <button onClick={() => setDismissAlert(a)} disabled={a.status === 'dismissed'}
                            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                            <X className="h-3.5 w-3.5" />Dismiss
                          </button>
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

      <MissingInvoiceModals
        chaseAlert={chaseAlert} resolveAlert={resolveAlert} dismissAlert={dismissAlert}
        onClose={() => { setChaseAlert(null); setResolveAlert(null); setDismissAlert(null); }}
        onSuccess={(msg) => { setToast({ msg, kind: 'ok' }); void load(); }}
        onError={(msg) => setToast({ msg, kind: 'err' })}
      />

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg border text-sm shadow-xl ${toastCls}`}>
          {toast.kind === 'ok' && <CheckCircle2 className="h-4 w-4 shrink-0" />}
          {toast.kind === 'err' && <AlertCircle className="h-4 w-4 shrink-0" />}
          {toast.kind === 'warn' && <Clock className="h-4 w-4 shrink-0" />}
          <span>{toast.msg}</span>
          <button onClick={() => setToast(null)} className="ml-2 opacity-60 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </AppLayout>
  );
}
