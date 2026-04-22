/**
 * Bank Statement Imports — PRD-05 Phase 7
 * Lists all bank statement PDF imports with status and navigation to review.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, AlertCircle, Upload, FileText } from 'lucide-react';

type ImportStatus = 'extracted' | 'reviewing' | 'committed' | 'rolled_back';

interface BankStatementImport {
  id: string;
  bankAccountId: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  status: ImportStatus;
  createdAt: string;
}

type Toast = { msg: string; kind: 'ok' | 'err' } | null;

function fmtDate(s: string | null): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
}

function StatusBadge({ status }: { status: ImportStatus }) {
  const cfg: Record<ImportStatus, { cls: string; label: string }> = {
    extracted:   { cls: 'bg-blue-500/20 text-blue-400 border-blue-500/30',    label: 'Extracted' },
    reviewing:   { cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30', label: 'Reviewing' },
    committed:   { cls: 'bg-teal-500/20 text-teal-400 border-teal-500/30',    label: 'Committed' },
    rolled_back: { cls: 'bg-slate-600/30 text-slate-400 border-slate-500/30', label: 'Rolled back' },
  };
  const { cls, label } = cfg[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

const TH = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--ff-text-tertiary)]';

export default function BankStatementsIndexPage() {
  const router = useRouter();
  const [imports, setImports] = useState<BankStatementImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/bank-statements');
      const json = await res.json() as { data?: BankStatementImport[]; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load statement imports'); return; }
      setImports(Array.isArray(json.data) ? json.data : []);
    } catch { setError('Network error loading statement imports'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Bank Statement Imports</h1>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-1">Upload and review PDF bank statements before committing to transactions.</p>
            </div>
            <button
              onClick={() => router.push('/accounting/bank/statements/import-pdf')}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition-colors shrink-0"
            >
              <Upload className="h-4 w-4" />
              Upload PDF
            </button>
          </div>
        </div>

        <div className="px-6 py-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-4">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
            </div>
          ) : imports.length === 0 ? (
            <div className="text-center py-20">
              <FileText className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3 opacity-40" />
              <p className="text-[var(--ff-text-secondary)] text-sm">No imports yet — upload a PDF bank statement to get started.</p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className={TH}>Date uploaded</th>
                    <th className={TH}>Bank account</th>
                    <th className={TH}>Period</th>
                    <th className={TH}>Rows</th>
                    <th className={TH}>Imported</th>
                    <th className={TH}>Duplicates</th>
                    <th className={TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map(imp => (
                    <tr
                      key={imp.id}
                      onClick={() => router.push(`/accounting/bank/statements/import-pdf?id=${imp.id}`)}
                      className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 text-xs font-mono text-[var(--ff-text-secondary)]">
                        {fmtDate(imp.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--ff-text-primary)] font-medium">
                        {imp.bankAccountId}
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--ff-text-secondary)]">
                        {imp.periodStart || imp.periodEnd
                          ? `${fmtDate(imp.periodStart)} – ${fmtDate(imp.periodEnd)}`
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-[var(--ff-text-secondary)]">{imp.rowCount}</td>
                      <td className="px-4 py-3 text-xs font-mono text-teal-400">{imp.importedCount}</td>
                      <td className="px-4 py-3 text-xs font-mono text-amber-400">{imp.duplicateCount}</td>
                      <td className="px-4 py-3"><StatusBadge status={imp.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg border text-sm shadow-xl ${toast.kind === 'ok' ? 'bg-teal-900/80 text-teal-200 border-teal-700' : 'bg-red-900/80 text-red-200 border-red-700'}`}>
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{toast.msg}</span>
        </div>
      )}
    </AppLayout>
  );
}
