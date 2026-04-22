/**
 * Fraud Signals — PRD-05 Phase 11
 *
 * Tenant-visible cross-tenant fraud alerts. Each row shows the signal type,
 * supplier, severity, evidence fields, and a dismiss / confirm action.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  ShieldAlert, AlertCircle, Loader2, RefreshCw, Check, X, ScanLine,
  Info, AlertTriangle, Shield,
} from 'lucide-react';

interface Alert {
  id: string;
  supplierId: string;
  supplierName: string;
  signalType: 'vat_mismatch' | 'bank_change' | 'email_spoof' | 'layout_anomaly' | 'duplicate_vat';
  severity: 'info' | 'warning' | 'critical';
  evidence: Record<string, unknown>;
  status: 'pending' | 'dismissed' | 'confirmed';
  firstSeenAt: string;
}

const SIGNAL_LABELS: Record<Alert['signalType'], string> = {
  vat_mismatch:   'VAT mismatch',
  bank_change:    'Bank account change',
  email_spoof:    'Possible email spoof',
  layout_anomaly: 'Invoice layout anomaly',
  duplicate_vat:  'VAT reg used by multiple suppliers',
};

const SEVERITY_STYLES: Record<Alert['severity'], { icon: typeof Info; text: string }> = {
  info:     { icon: Info,           text: 'bg-blue-900/40 text-blue-300' },
  warning:  { icon: AlertTriangle,  text: 'bg-amber-900/40 text-amber-300' },
  critical: { icon: ShieldAlert,    text: 'bg-red-900/50 text-red-300' },
};

function fmtDate(s: string): string {
  try { return new Date(s).toLocaleString('en-ZA'); } catch { return s; }
}

export default function FraudSignalsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [status, setStatus] = useState<'pending' | 'dismissed' | 'confirmed' | ''>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = status ? `?status=${status}` : '';
      const res = await apiFetch(`/api/accounting/fraud/signals${qs}`);
      const json = await res.json() as { data?: { alerts?: Alert[] }; error?: { message?: string } | string };
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : json.error?.message ?? 'Failed'); return;
      }
      setAlerts(json.data?.alerts ?? []);
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  async function runScan() {
    setScanning(true);
    try {
      const res = await apiFetch('/api/accounting/fraud/scan', { method: 'POST', body: '{}' });
      const json = await res.json() as { data?: { created?: number; refreshed?: number }; error?: { message?: string } | string };
      if (!res.ok) {
        showToast(typeof json.error === 'string' ? json.error : json.error?.message ?? 'Scan failed', false); return;
      }
      const d = json.data ?? {};
      showToast(`Scan complete — ${d.created ?? 0} new, ${d.refreshed ?? 0} refreshed`, true);
      void load();
    } catch { showToast('Network error', false); }
    finally { setScanning(false); }
  }

  async function act(id: string, action: 'dismiss' | 'confirm') {
    try {
      const res = await apiFetch(`/api/accounting/fraud/${id}/${action}`, {
        method: 'POST', body: '{}',
      });
      const json = await res.json() as { error?: { message?: string } | string };
      if (!res.ok) {
        showToast(typeof json.error === 'string' ? json.error : json.error?.message ?? `${action} failed`, false); return;
      }
      showToast(action === 'confirm' ? 'Confirmed as fraud' : 'Dismissed', true);
      void load();
    } catch { showToast('Network error', false); }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
              <Shield className="h-5 w-5 text-teal-400" /> Fraud Signals
            </h1>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">
              Cross-tenant supplier-fraud alerts. Advisory only — dismiss signals that aren't relevant to your setup.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)]">
              <select value={status} onChange={e => setStatus(e.target.value as typeof status)}
                className="bg-transparent text-xs text-slate-300 focus:outline-none">
                <option value="pending">Pending</option>
                <option value="dismissed">Dismissed</option>
                <option value="confirmed">Confirmed</option>
                <option value="">All</option>
              </select>
            </div>
            <button onClick={() => void load()} className="inline-flex items-center gap-2 px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-sm">
              <RefreshCw className="h-4 w-4" />
            </button>
            <button onClick={() => void runScan()} disabled={scanning}
              className="inline-flex items-center gap-2 px-3 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-60">
              {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
              Run scan
            </button>
          </div>
        </div>

        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded shadow-lg text-sm ${toast.ok ? 'bg-teal-600 text-white' : 'bg-red-700 text-white'}`}>
            {toast.msg}
          </div>
        )}

        <div className="px-6 py-6">
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 text-red-400 py-10 justify-center">
                <AlertCircle className="h-5 w-5" />{error}
              </div>
            ) : alerts.length === 0 ? (
              <div className="py-16 text-center">
                <Shield className="h-10 w-10 mx-auto text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">No {status || 'active'} fraud signals</p>
                <p className="text-slate-600 text-xs mt-1">Run a scan to check your suppliers against the shared graph.</p>
              </div>
            ) : (
              <ul className="divide-y divide-[rgba(255,255,255,0.04)]">
                {alerts.map(a => {
                  const Icon = SEVERITY_STYLES[a.severity].icon;
                  return (
                    <li key={a.id} className="px-6 py-4 hover:bg-white/5">
                      <div className="flex items-start gap-4">
                        <span className={`inline-flex items-center justify-center w-8 h-8 rounded ${SEVERITY_STYLES[a.severity].text}`}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-sm font-semibold text-slate-100">{SIGNAL_LABELS[a.signalType]}</p>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${SEVERITY_STYLES[a.severity].text}`}>{a.severity}</span>
                          </div>
                          <p className="text-sm text-slate-300">{a.supplierName}</p>
                          <div className="mt-2 text-xs text-slate-500 font-mono">
                            {Object.entries(a.evidence).slice(0, 4).map(([k, v]) => (
                              <span key={k} className="inline-block mr-3">
                                <span className="text-slate-600">{k}:</span> {String(v)}
                              </span>
                            ))}
                          </div>
                          <p className="text-xs text-slate-600 mt-2">Seen {fmtDate(a.firstSeenAt)}</p>
                        </div>
                        {a.status === 'pending' && (
                          <div className="flex gap-2 shrink-0">
                            <button onClick={() => void act(a.id, 'confirm')}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-red-700/80 hover:bg-red-600 text-white text-xs font-medium">
                              <Check className="h-3.5 w-3.5" /> Confirm fraud
                            </button>
                            <button onClick={() => void act(a.id, 'dismiss')}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-xs">
                              <X className="h-3.5 w-3.5" /> Dismiss
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
