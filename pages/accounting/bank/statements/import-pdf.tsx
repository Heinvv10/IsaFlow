/**
 * Bank Statement PDF Import & Review — PRD-05 Phase 7
 * Upload mode (no ?id): drag-drop PDF + bank account selector.
 * Review mode (?id=<importId>): delegates to StatementReviewPanel.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, AlertCircle, Upload, CheckCircle2, ArrowLeft } from 'lucide-react';
import { StatementReviewPanel, type BankStatementImport } from '@/components/accounting/bank-transactions/StatementReviewPanel';

interface BankAccount { id: string; name: string; accountNumber?: string; }

type Toast = { msg: string; kind: 'ok' | 'err' } | null;

function readCompanyId(): string | null {
  if (typeof window === 'undefined') return null;
  try { const s = localStorage.getItem('isaflow_active_company'); return s ? (JSON.parse(s) as { id: string }).id : null; } catch { return null; }
}

function readCsrf(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.split('; ').find(c => c.startsWith('isaflow_csrf='));
  return m ? m.slice('isaflow_csrf='.length) : null;
}

function ToastBar({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  if (!toast) return null;
  const cls = toast.kind === 'ok' ? 'bg-teal-900/80 text-teal-200 border-teal-700' : 'bg-red-900/80 text-red-200 border-red-700';
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg border text-sm shadow-xl ${cls}`}>
      {toast.kind === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
      <span>{toast.msg}</span>
      <button onClick={onDismiss} className="ml-2 opacity-60 hover:opacity-100" aria-label="Dismiss"><AlertCircle className="h-3.5 w-3.5 hidden" /></button>
    </div>
  );
}

export default function ImportPdfPage() {
  const router = useRouter();
  const { id: queryId } = router.query;
  const importId = typeof queryId === 'string' ? queryId : null;

  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [imp, setImp] = useState<BankStatementImport | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast>(null);

  const showToast = useCallback((msg: string, kind: 'ok' | 'err') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/bank-accounts');
      const json = await res.json() as { data?: BankAccount[] };
      const list = Array.isArray(json.data) ? json.data : [];
      setAccounts(list);
      if (list.length > 0) setSelectedAccount(list[0]!.id);
    } catch { /* non-fatal */ }
  }, []);

  const loadImport = useCallback(async (id: string) => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/accounting/bank-statements/${id}`);
      const json = await res.json() as { data?: BankStatementImport; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load import'); return; }
      setImp(json.data ?? null);
    } catch { setError('Network error loading import'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (importId) void loadImport(importId);
    else void loadAccounts();
  }, [importId, loadImport, loadAccounts]);

  const handleUpload = useCallback(async () => {
    if (!file || !selectedAccount) return;
    if (file.size > 10 * 1024 * 1024) { showToast('File exceeds 10 MB limit', 'err'); return; }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('bankAccountId', selectedAccount);
      const headers = new Headers();
      const cid = readCompanyId(); if (cid) headers.set('X-Company-Id', cid);
      const csrf = readCsrf(); if (csrf) headers.set('X-CSRF-Token', csrf);
      const res = await fetch('/api/accounting/bank-statements', { method: 'POST', body: form, headers, credentials: 'include' });
      const json = await res.json() as { data?: BankStatementImport; error?: string };
      if (!res.ok) { showToast(json.error ?? 'Upload failed', 'err'); return; }
      if (json.data?.id) void router.push(`/accounting/bank/statements/import-pdf?id=${json.data.id}`);
    } catch { showToast('Network error during upload', 'err'); }
    finally { setUploading(false); }
  }, [file, selectedAccount, router, showToast]);

  const handleCommit = useCallback(async () => {
    if (!importId) return;
    setCommitting(true);
    try {
      const res = await apiFetch(`/api/accounting/bank-statements/${importId}/commit`, { method: 'POST' });
      const json = await res.json() as { data?: { inserted: number; skipped: number }; error?: string };
      if (!res.ok) { showToast(json.error ?? 'Commit failed', 'err'); return; }
      showToast(`Inserted ${json.data?.inserted ?? 0}, skipped ${json.data?.skipped ?? 0}`, 'ok');
      void loadImport(importId);
    } catch { showToast('Network error during commit', 'err'); }
    finally { setCommitting(false); }
  }, [importId, loadImport, showToast]);

  const handleRollback = useCallback(async () => {
    if (!importId) return;
    setRollingBack(true);
    try {
      const res = await apiFetch(`/api/accounting/bank-statements/${importId}/rollback`, { method: 'POST' });
      if (!res.ok) { showToast('Rollback failed', 'err'); return; }
      showToast('Import rolled back', 'ok');
      void loadImport(importId);
    } catch { showToast('Network error during rollback', 'err'); }
    finally { setRollingBack(false); }
  }, [importId, loadImport, showToast]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === 'application/pdf') setFile(dropped);
    else showToast('Only PDF files are accepted', 'err');
  };

  const backBtn = (
    <button onClick={() => router.push('/accounting/bank/statements')}
      className="flex items-center gap-1.5 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-3 transition-colors">
      <ArrowLeft className="h-4 w-4" /> Back to imports
    </button>
  );

  // ─── Review mode ──────────────────────────────────────────────────────────

  if (importId) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)]">
          <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
            {backBtn}
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Review Statement Import</h1>
          </div>
          <div className="px-6 py-4">
            {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-4"><AlertCircle className="h-4 w-4" />{error}</div>}
            {loading
              ? <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-indigo-400" /></div>
              : imp
                ? <StatementReviewPanel imp={imp} committing={committing} rollingBack={rollingBack} onCommit={handleCommit} onRollback={handleRollback} />
                : null}
          </div>
        </div>
        <ToastBar toast={toast} onDismiss={() => setToast(null)} />
      </AppLayout>
    );
  }

  // ─── Upload mode ──────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          {backBtn}
          <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Upload Bank Statement PDF</h1>
          <p className="text-sm text-[var(--ff-text-secondary)] mt-1">PDF only · max 10 MB · transactions reviewed before committing.</p>
        </div>

        <div className="px-6 py-6 max-w-xl space-y-5">
          <div>
            <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">Bank account</label>
            <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-indigo-500/50">
              {accounts.length === 0 && <option value="">Loading accounts…</option>}
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>)}
            </select>
          </div>

          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-3 py-14 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${dragging ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-[var(--ff-border-light)] hover:border-indigo-500/40 hover:bg-indigo-500/5'}`}
          >
            <Upload className={`h-10 w-10 ${dragging ? 'text-indigo-400' : 'text-[var(--ff-text-tertiary)]'}`} />
            {file
              ? <div className="text-center"><p className="text-sm font-medium text-[var(--ff-text-primary)]">{file.name}</p><p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{(file.size / 1024).toFixed(0)} KB</p></div>
              : <div className="text-center"><p className="text-sm font-medium text-[var(--ff-text-primary)]">Drag &amp; drop PDF here</p><p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">or click to browse</p></div>}
          </div>
          <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); }} />

          <button onClick={handleUpload} disabled={!file || !selectedAccount || uploading}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white transition-colors">
            {uploading ? <><Loader2 className="h-4 w-4 animate-spin" />Uploading…</> : <><Upload className="h-4 w-4" />Upload &amp; extract</>}
          </button>
        </div>
      </div>
      <ToastBar toast={toast} onDismiss={() => setToast(null)} />
    </AppLayout>
  );
}
