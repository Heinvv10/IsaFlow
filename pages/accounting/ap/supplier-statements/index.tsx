/**
 * Supplier Statement Reconciliation List — PRD-05 Phase 7
 * Lists all supplier statement reconciliations with balance variance indicators.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, AlertCircle, Upload, X, CheckCircle2, FileText } from 'lucide-react';

type ReconStatus = 'unreconciled' | 'reconciled' | 'disputed' | 'archived';

interface Supplier { id: string; name: string; }

interface SupplierStatementReconciliation {
  id: string; supplierId: string; supplierName: string;
  statementDate: string; periodStart: string | null; periodEnd: string | null;
  supplierBalance: number; isaflowBalance: number; variance: number;
  status: ReconStatus;
  missingInIsaflowCount: number; missingInStatementCount: number; amountDiffCount: number;
  createdAt: string;
}

type Toast = { msg: string; kind: 'ok' | 'err' } | null;

function fmtZAR(n: number) {
  return 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
}

function readCompanyId(): string | null {
  if (typeof window === 'undefined') return null;
  try { const s = localStorage.getItem('isaflow_active_company'); return s ? (JSON.parse(s) as { id: string }).id : null; } catch { return null; }
}

function readCsrf(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.split('; ').find(c => c.startsWith('isaflow_csrf='));
  return m ? m.slice('isaflow_csrf='.length) : null;
}

function VarianceBadge({ variance }: { variance: number }) {
  const abs = Math.abs(variance);
  const cls = abs <= 0.01 ? 'text-teal-400' : abs <= 100 ? 'text-amber-400' : 'text-red-400';
  return <span className={`font-mono text-xs font-medium ${cls}`}>{fmtZAR(variance)}</span>;
}

function StatusBadge({ status }: { status: ReconStatus }) {
  const cfg: Record<ReconStatus, { cls: string; label: string }> = {
    unreconciled: { cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30', label: 'Unreconciled' },
    reconciled:   { cls: 'bg-teal-500/20 text-teal-400 border-teal-500/30',    label: 'Reconciled' },
    disputed:     { cls: 'bg-red-500/20 text-red-400 border-red-500/30',       label: 'Disputed' },
    archived:     { cls: 'bg-slate-600/30 text-slate-400 border-slate-500/30', label: 'Archived' },
  };
  const { cls, label } = cfg[status];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium ${cls}`}>{label}</span>;
}

const TH = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--ff-text-tertiary)]';

export default function SupplierStatementsIndexPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [statements, setStatements] = useState<SupplierStatementReconciliation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast>(null);

  // Filters
  const [filterSupplier, setFilterSupplier] = useState('');
  const [filterStatus, setFilterStatus] = useState<ReconStatus | 'all'>('all');

  // Upload modal
  const [modalOpen, setModalOpen] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [modalSupplier, setModalSupplier] = useState('');
  const [modalFile, setModalFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const showToast = useCallback((msg: string, kind: 'ok' | 'err') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = filterSupplier ? `?supplierId=${encodeURIComponent(filterSupplier)}` : '';
      const res = await apiFetch(`/api/accounting/supplier-statements${qs}`);
      const json = await res.json() as { data?: SupplierStatementReconciliation[]; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load supplier statements'); return; }
      setStatements(Array.isArray(json.data) ? json.data : []);
    } catch { setError('Network error loading supplier statements'); }
    finally { setLoading(false); }
  }, [filterSupplier]);

  useEffect(() => { void load(); }, [load]);

  const loadSuppliers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/suppliers?limit=500');
      const json = await res.json() as { data?: Supplier[] };
      const list = Array.isArray(json.data) ? json.data : [];
      setSuppliers(list);
      if (list.length > 0) setModalSupplier(list[0]!.id);
    } catch { /* non-fatal */ }
  }, []);

  const openModal = () => { setModalOpen(true); void loadSuppliers(); };

  const handleUpload = useCallback(async () => {
    if (!modalFile || !modalSupplier) return;
    if (modalFile.size > 10 * 1024 * 1024) { showToast('File exceeds 10 MB limit', 'err'); return; }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', modalFile);
      form.append('supplierId', modalSupplier);
      const headers = new Headers();
      const cid = readCompanyId(); if (cid) headers.set('X-Company-Id', cid);
      const csrf = readCsrf(); if (csrf) headers.set('X-CSRF-Token', csrf);
      const res = await fetch('/api/accounting/supplier-statements', { method: 'POST', body: form, headers, credentials: 'include' });
      const json = await res.json() as { data?: SupplierStatementReconciliation; error?: string };
      if (!res.ok) { showToast(json.error ?? 'Upload failed', 'err'); return; }
      setModalOpen(false); setModalFile(null);
      if (json.data?.id) void router.push(`/accounting/ap/supplier-statements/${json.data.id}`);
    } catch { showToast('Network error during upload', 'err'); }
    finally { setUploading(false); }
  }, [modalFile, modalSupplier, router, showToast]);

  const filtered = statements.filter(s =>
    (filterStatus === 'all' || s.status === filterStatus)
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier Statements</h1>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-1">Reconcile supplier PDF statements against IsaFlow invoices.</p>
            </div>
            <button onClick={openModal} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition-colors shrink-0">
              <Upload className="h-4 w-4" /> Upload statement
            </button>
          </div>
        </div>

        <div className="px-6 py-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-indigo-500/50 min-w-[160px]">
              <option value="">All suppliers</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {(['all', 'unreconciled', 'reconciled', 'disputed', 'archived'] as const).map(f => (
              <button key={f} onClick={() => setFilterStatus(f)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors capitalize ${filterStatus === f ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40' : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] hover:border-indigo-500/40'}`}>
                {f === 'all' ? 'All statuses' : f}
              </button>
            ))}
            <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{filtered.length} statement{filtered.length !== 1 ? 's' : ''}</span>
          </div>

          {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-4"><AlertCircle className="h-4 w-4" />{error}</div>}

          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-indigo-400" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20"><FileText className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3 opacity-40" /><p className="text-[var(--ff-text-secondary)] text-sm">No statements found.</p></div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[800px]">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className={TH}>Statement date</th><th className={TH}>Supplier</th>
                    <th className={TH}>Period</th><th className={`${TH} text-right`}>Supplier bal.</th>
                    <th className={`${TH} text-right`}>IsaFlow bal.</th><th className={`${TH} text-right`}>Variance</th>
                    <th className={TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(s => (
                    <tr key={s.id} onClick={() => router.push(`/accounting/ap/supplier-statements/${s.id}`)}
                      className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5 cursor-pointer transition-colors">
                      <td className="px-4 py-3 text-xs font-mono text-[var(--ff-text-secondary)]">{fmtDate(s.statementDate)}</td>
                      <td className="px-4 py-3 text-xs font-medium text-[var(--ff-text-primary)]">{s.supplierName}</td>
                      <td className="px-4 py-3 text-xs text-[var(--ff-text-secondary)]">{s.periodStart || s.periodEnd ? `${fmtDate(s.periodStart)} – ${fmtDate(s.periodEnd)}` : '—'}</td>
                      <td className="px-4 py-3 text-xs font-mono text-right text-[var(--ff-text-secondary)]">{fmtZAR(s.supplierBalance)}</td>
                      <td className="px-4 py-3 text-xs font-mono text-right text-[var(--ff-text-secondary)]">{fmtZAR(s.isaflowBalance)}</td>
                      <td className="px-4 py-3 text-right"><VarianceBadge variance={s.variance} /></td>
                      <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Upload modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[var(--ff-text-primary)]">Upload Supplier Statement</h2>
              <button onClick={() => { setModalOpen(false); setModalFile(null); }} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"><X className="h-5 w-5" /></button>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">Supplier</label>
              <select value={modalSupplier} onChange={e => setModalSupplier(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-indigo-500/50">
                {suppliers.length === 0 && <option value="">Loading…</option>}
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">Statement PDF</label>
              <div onClick={() => fileRef.current?.click()}
                className="flex flex-col items-center gap-2 py-8 rounded-lg border-2 border-dashed border-[var(--ff-border-light)] hover:border-indigo-500/40 cursor-pointer transition-colors">
                <Upload className="h-7 w-7 text-[var(--ff-text-tertiary)]" />
                {modalFile ? <p className="text-sm text-[var(--ff-text-primary)]">{modalFile.name}</p> : <p className="text-sm text-[var(--ff-text-secondary)]">Click to select PDF (max 10 MB)</p>}
              </div>
              <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setModalFile(f); }} />
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => { setModalOpen(false); setModalFile(null); }}
                className="flex-1 py-2.5 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">Cancel</button>
              <button onClick={handleUpload} disabled={!modalFile || !modalSupplier || uploading}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg border text-sm shadow-xl ${toast.kind === 'ok' ? 'bg-teal-900/80 text-teal-200 border-teal-700' : 'bg-red-900/80 text-red-200 border-red-700'}`}>
          {toast.kind === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          <span>{toast.msg}</span>
          <button onClick={() => setToast(null)} className="ml-2 opacity-60 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </AppLayout>
  );
}
