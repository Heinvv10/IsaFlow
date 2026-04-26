/**
 * Supplier Expectations — PRD-05 Phase 6
 * Learned billing cadence per supplier. Auto-locks after 3+ consistent invoices.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { RefreshCw, AlertCircle, Loader2, X, CheckCircle2, Clock, Search } from 'lucide-react';

interface SupplierExpectation {
  id: string; companyId: string; supplierId: string;
  cadence: 'monthly' | 'quarterly' | 'annual' | 'irregular';
  expectedDayOfMonth: number | null;
  expectedAmount: number | null;
  amountStddev: number | null;
  lastInvoiceDate: string | null;
  lastInvoiceAmount: number | null;
  sampleSize: number;
  status: 'learning' | 'locked' | 'paused';
  lastRecomputedAt: string | null;
  supplierName?: string;
}

type StatusFilter = 'all' | 'locked' | 'learning' | 'paused';
type Toast = { msg: string; kind: 'ok' | 'err' | 'warn' } | null;

const CADENCE_GAP: Record<string, number> = { monthly: 30, quarterly: 91, annual: 365 };

const fmtZAR = (n: number | null) =>
  n == null ? '—' : 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (s: string | Date | null) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
};

function nextExpected(exp: SupplierExpectation): string {
  if (exp.cadence === 'irregular' || !exp.lastInvoiceDate) return '—';
  const gap = CADENCE_GAP[exp.cadence];
  if (!gap) return '—';
  try {
    const base = new Date(exp.lastInvoiceDate);
    base.setDate(base.getDate() + gap);
    return base.toLocaleDateString('en-ZA');
  } catch { return '—'; }
}

function CadenceBadge({ cadence }: { cadence: SupplierExpectation['cadence'] }) {
  const map: Record<string, string> = {
    monthly: 'bg-blue-900/40 text-blue-300 border-blue-700/30',
    quarterly: 'bg-indigo-900/40 text-indigo-300 border-indigo-700/30',
    annual: 'bg-purple-900/40 text-purple-300 border-purple-700/30',
    irregular: 'bg-gray-700/40 text-gray-400 border-gray-600/30',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${map[cadence] ?? map.irregular}`}>
      {cadence}
    </span>
  );
}

function StatusBadge({ status }: { status: SupplierExpectation['status'] }) {
  const map: Record<string, string> = {
    learning: 'bg-gray-700/40 text-gray-300 border-gray-600/30',
    locked: 'bg-teal-900/40 text-teal-300 border-teal-700/30',
    paused: 'bg-amber-900/40 text-amber-300 border-amber-700/30',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${map[status] ?? map.learning}`}>
      {status}
    </span>
  );
}

export default function SupplierExpectationsPage() {
  const [rows, setRows] = useState<SupplierExpectation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [recomputingId, setRecomputingId] = useState<string | null>(null);
  const [recomputingAll, setRecomputingAll] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-expectations');
      const json = await res.json() as { data?: SupplierExpectation[]; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load expectations'); return; }
      setRows(Array.isArray(json.data) ? json.data : []);
    } catch { setError('Network error loading supplier expectations'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const recompute = useCallback(async (supplierId: string, rowId: string) => {
    setRecomputingId(rowId);
    try {
      const res = await apiFetch('/api/accounting/supplier-expectations/recompute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId }),
      });
      const json = await res.json() as { data?: SupplierExpectation; error?: string };
      if (!res.ok) { setToast({ msg: json.error ?? 'Recompute failed', kind: 'err' }); return; }
      if (json.data) {
        setRows(prev => prev.map(r => r.id === rowId ? { ...r, ...json.data } : r));
        setToast({ msg: 'Expectation recomputed', kind: 'ok' });
      }
    } catch { setToast({ msg: 'Network error during recompute', kind: 'err' }); }
    finally { setRecomputingId(null); }
  }, []);

  const recomputeAll = useCallback(async () => {
    setRecomputingAll(true);
    try {
      const res = await apiFetch('/api/accounting/supplier-expectations/recompute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { data?: { processed: number; locked: number }; error?: string };
      if (!res.ok) { setToast({ msg: json.error ?? 'Recompute all failed', kind: 'err' }); return; }
      setToast({ msg: `Recomputed ${json.data?.processed ?? 0} expectations, ${json.data?.locked ?? 0} locked`, kind: 'ok' });
      void load();
    } catch { setToast({ msg: 'Network error during recompute all', kind: 'err' }); }
    finally { setRecomputingAll(false); }
  }, [load]);

  const filtered = rows
    .filter(r => statusFilter === 'all' || r.status === statusFilter)
    .filter(r => !search || (r.supplierName ?? r.supplierId).toLowerCase().includes(search.toLowerCase()));

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
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier Expectations</h1>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-1 max-w-xl">
                Learned billing cadence per supplier. The system auto-locks a cadence after 3+ consistent invoices.
              </p>
            </div>
            <button
              onClick={recomputeAll}
              disabled={recomputingAll}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white transition-colors shrink-0"
            >
              <RefreshCw className={`h-4 w-4 ${recomputingAll ? 'animate-spin' : ''}`} />
              Recompute all
            </button>
          </div>
        </div>

        <div className="px-6 py-4">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search supplier..."
                className="w-full pl-9 pr-3 py-2 rounded-lg text-sm bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] focus:outline-none focus:border-teal-500/50"
              />
            </div>
            {(['all', 'locked', 'learning', 'paused'] as StatusFilter[]).map(f => (
              <button key={f} onClick={() => setStatusFilter(f)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors capitalize ${statusFilter === f ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40' : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] hover:border-teal-500/40'}`}>
                {f}
              </button>
            ))}
            <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{filtered.length} supplier{filtered.length !== 1 ? 's' : ''}</span>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-4">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-teal-400" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 px-8 max-w-2xl mx-auto">
              <RefreshCw className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3 opacity-40" />
              <p className="text-[var(--ff-text-secondary)] text-sm leading-relaxed">
                {rows.length === 0
                  ? 'No expectations computed yet — post at least 2 supplier invoices first.'
                  : 'No expectations match the current filter.'}
              </p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className={TH}>Supplier</th>
                    <th className={TH}>Cadence</th>
                    <th className={TH}>Next expected</th>
                    <th className={TH}>Expected amount</th>
                    <th className={TH}>Last invoice</th>
                    <th className={TH}>Samples</th>
                    <th className={TH}>Status</th>
                    <th className={TH}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.id} className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5 transition-colors">
                      <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)] text-xs">
                        {r.supplierName ?? r.supplierId}
                      </td>
                      <td className="px-4 py-3"><CadenceBadge cadence={r.cadence} /></td>
                      <td className="px-4 py-3 text-xs font-mono text-[var(--ff-text-secondary)]">{nextExpected(r)}</td>
                      <td className="px-4 py-3 text-xs font-mono text-[var(--ff-text-secondary)]">{fmtZAR(r.expectedAmount)}</td>
                      <td className="px-4 py-3 text-xs text-[var(--ff-text-secondary)]">
                        <span className="block">{fmtDate(r.lastInvoiceDate)}</span>
                        {r.lastInvoiceAmount != null && (
                          <span className="text-[var(--ff-text-tertiary)] font-mono">{fmtZAR(r.lastInvoiceAmount)}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-center text-[var(--ff-text-secondary)]">{r.sampleSize}</td>
                      <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => recompute(r.supplierId, r.id)}
                          disabled={recomputingId === r.id}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 disabled:opacity-50 transition-colors"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${recomputingId === r.id ? 'animate-spin' : ''}`} />
                          Recompute
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

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
