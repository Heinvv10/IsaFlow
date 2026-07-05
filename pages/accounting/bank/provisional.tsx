/**
 * Provisional Entries (Bank-First) — PRD-05 Phase 5
 * Bank transactions posted by AI without evidence. Attach a slip or invoice to confirm.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Clock, AlertCircle, Loader2, Paperclip, X, ChevronUp, ChevronDown, CheckCircle2 } from 'lucide-react';

interface ProvisionalEntry {
  jeId: string; bankTxId: string; bankAccountName: string; description: string;
  amount: number; transactionDate: string; daysOutstanding: number;
  predictedSupplierId: string | null; predictedSupplierName: string | null;
  predictionConfidence: number; glAccountId: string | null; glAccountName: string | null;
  postedAt: string;
}
interface CapturedDoc {
  id: string; fileName: string; vendorName: string | null;
  documentDate: string | null; totalAmount: number | null; documentType: string | null;
}

type DaysFilter = 'all' | '3' | '5' | '7';
type SortKey = 'transactionDate' | 'amount' | 'daysOutstanding' | 'predictedSupplierName';
type SortDir = 'asc' | 'desc';
type Toast = { msg: string; kind: 'ok' | 'err' | 'warn' } | null;

const fmtZAR = (n: number) => 'R ' + Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s: string | null) => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return s; } };

function ConfBadge({ v }: { v: number }) {
  const cls = v >= 0.9 ? 'bg-teal-900/40 text-teal-300' : v >= 0.7 ? 'bg-amber-900/40 text-amber-300' : 'bg-red-900/40 text-red-300';
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{Math.round(v * 100)}%</span>;
}
function DaysBadge({ d }: { d: number }) {
  const cls = d >= 5 ? 'text-red-400' : d >= 3 ? 'text-amber-400' : 'text-[var(--ff-text-tertiary)]';
  return <span className={`text-xs font-medium ${cls}`}>{d}d</span>;
}

export default function ProvisionalEntriesPage() {
  const [entries, setEntries] = useState<ProvisionalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [daysFilter, setDaysFilter] = useState<DaysFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('daysOutstanding');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [attachJeId, setAttachJeId] = useState<string | null>(null);
  const [dismissJeId, setDismissJeId] = useState<string | null>(null);
  const [docs, setDocs] = useState<CapturedDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/provisional/outstanding');
      const json = await res.json() as { data?: { outstanding?: ProvisionalEntry[] }; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load provisional entries'); return; }
      setEntries(json.data?.outstanding ?? []);
    } catch { setError('Network error loading provisional entries'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';
    if (hash) document.getElementById(`tx-${hash}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [entries]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const openAttach = useCallback(async (jeId: string) => {
    setAttachJeId(jeId); setDocsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/document-capture?status=extracted&pageSize=50');
      const json = await res.json() as { data?: CapturedDoc[] };
      setDocs(json.data ?? []);
    } catch { log.error('Failed to load captured documents', {}, 'provisional-ui'); setDocs([]); }
    finally { setDocsLoading(false); }
  }, []);

  const handleAttach = useCallback(async (capturedDocumentId: string) => {
    if (!attachJeId || submitting) return;
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/accounting/provisional/${attachJeId}/attach`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capturedDocumentId }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) { setToast({ msg: json.error ?? 'Attach failed', kind: 'err' }); return; }
      setToast({ msg: 'Evidence attached successfully', kind: 'ok' });
      setAttachJeId(null); void load();
    } catch { setToast({ msg: 'Network error attaching evidence', kind: 'err' }); }
    finally { setSubmitting(false); }
  }, [attachJeId, submitting, load]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const filtered = entries
    .filter(e => daysFilter === 'all' || e.daysOutstanding >= Number(daysFilter))
    .sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'transactionDate') cmp = a.transactionDate.localeCompare(b.transactionDate);
      else if (sortKey === 'amount') cmp = a.amount - b.amount;
      else if (sortKey === 'daysOutstanding') cmp = a.daysOutstanding - b.daysOutstanding;
      else cmp = (a.predictedSupplierName ?? '').localeCompare(b.predictedSupplierName ?? '');
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const SI = ({ col }: { col: SortKey }) => sortKey !== col
    ? <ChevronDown className="h-3 w-3 opacity-30" />
    : sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />;

  const TH = 'px-4 py-3 text-left font-medium';
  const toastCls = toast?.kind === 'ok' ? 'bg-teal-900/80 text-teal-200 border-teal-700' : toast?.kind === 'warn' ? 'bg-amber-900/80 text-amber-200 border-amber-700' : 'bg-red-900/80 text-red-200 border-red-700';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-amber-500/10"><Clock className="h-5 w-5 text-amber-400" /></div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Provisional Entries (Bank-First)</h1>
          </div>
          <p className="text-sm text-[var(--ff-text-secondary)] ml-12">Bank transactions posted by AI without evidence. Attach a slip or invoice to confirm.</p>
        </div>

        <div className="px-6 py-4">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <span className="text-sm text-[var(--ff-text-secondary)]">Days outstanding:</span>
            {(['all', '3', '5', '7'] as DaysFilter[]).map(f => (
              <button key={f} onClick={() => setDaysFilter(f)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${daysFilter === f ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' : 'bg-[var(--ff-bg-secondary)] text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] hover:border-amber-500/40'}`}>
                {f === 'all' ? 'All' : `≥${f} days`}
              </button>
            ))}
            <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{filtered.length} entr{filtered.length !== 1 ? 'ies' : 'y'}</span>
          </div>
          {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-4"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}
          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-amber-400" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 px-8 max-w-2xl mx-auto">
              <Clock className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3 opacity-40" />
              <p className="text-[var(--ff-text-secondary)] text-sm leading-relaxed">No provisional entries awaiting evidence — the system posts bank transactions here when a supplier match is confident but no slip is attached yet. Connect a bank feed or import a statement to see this in action.</p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[800px]">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)] text-xs uppercase">
                    <th className={`${TH} cursor-pointer select-none`} onClick={() => toggleSort('transactionDate')}><span className="flex items-center gap-1">Bank Date <SI col="transactionDate" /></span></th>
                    <th className={TH}>Description</th>
                    <th className="px-4 py-3 text-right font-medium cursor-pointer select-none" onClick={() => toggleSort('amount')}><span className="flex items-center justify-end gap-1">Amount (R) <SI col="amount" /></span></th>
                    <th className={`${TH} cursor-pointer select-none`} onClick={() => toggleSort('predictedSupplierName')}><span className="flex items-center gap-1">Predicted Supplier <SI col="predictedSupplierName" /></span></th>
                    <th className={TH}>Predicted GL</th>
                    <th className="px-4 py-3 text-center font-medium cursor-pointer select-none" onClick={() => toggleSort('daysOutstanding')}><span className="flex items-center justify-center gap-1">Days Out <SI col="daysOutstanding" /></span></th>
                    <th className={TH}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(e => (
                    <tr key={e.jeId} id={`tx-${e.bankTxId}`}
                      className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-[var(--ff-text-secondary)]">{fmtDate(e.transactionDate)}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] max-w-[200px]">
                        <span className="line-clamp-2 text-xs">{e.description || '—'}</span>
                        <span className="block text-[var(--ff-text-tertiary)] text-xs">{e.bankAccountName}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{fmtZAR(e.amount)}</td>
                      <td className="px-4 py-3">
                        {e.predictedSupplierName
                          ? <div className="flex items-center gap-2 flex-wrap"><Link href={`/accounting/suppliers/${e.predictedSupplierId}`} className="text-xs text-blue-400 hover:underline">{e.predictedSupplierName}</Link><ConfBadge v={e.predictionConfidence} /></div>
                          : <span className="text-[var(--ff-text-tertiary)] text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--ff-text-secondary)]">{e.glAccountName ?? '—'}</td>
                      <td className="px-4 py-3 text-center"><DaysBadge d={e.daysOutstanding} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button onClick={() => openAttach(e.jeId)} className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 transition-colors"><Paperclip className="h-3.5 w-3.5" />Attach evidence</button>
                          <button onClick={() => setDismissJeId(e.jeId)} className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"><X className="h-3.5 w-3.5" />Dismiss</button>
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

      {attachJeId && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--ff-border-light)]">
              <h2 className="font-semibold text-[var(--ff-text-primary)]">Select captured document</h2>
              <button onClick={() => setAttachJeId(null)} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"><X className="h-5 w-5" /></button>
            </div>
            <div className="px-5 py-3 max-h-96 overflow-y-auto">
              {docsLoading ? <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-teal-400" /></div>
                : docs.length === 0 ? <p className="text-sm text-[var(--ff-text-secondary)] text-center py-8">No extracted documents found. Upload and extract a document via the Capture Inbox first.</p>
                : docs.map(d => (
                  <button key={d.id} onClick={() => handleAttach(d.id)} disabled={submitting}
                    className="w-full text-left flex items-center justify-between p-3 rounded-lg hover:bg-white/5 transition-colors border border-transparent hover:border-[var(--ff-border-light)] mb-1 disabled:opacity-50">
                    <div>
                      <p className="text-sm font-medium text-[var(--ff-text-primary)]">{d.vendorName ?? d.fileName}</p>
                      <p className="text-xs text-[var(--ff-text-tertiary)]">{d.documentType ?? 'Unknown type'} · {fmtDate(d.documentDate)}</p>
                    </div>
                    <span className="text-xs font-mono text-[var(--ff-text-secondary)] shrink-0 ml-2">{d.totalAmount != null ? fmtZAR(d.totalAmount) : '—'}</span>
                  </button>
                ))}
            </div>
            <div className="px-5 py-3 border-t border-[var(--ff-border-light)] flex justify-end">
              <button onClick={() => setAttachJeId(null)} className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {dismissJeId && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-sm p-6">
            <h2 className="font-semibold text-[var(--ff-text-primary)] mb-2">Dismiss provisional entry?</h2>
            <p className="text-sm text-[var(--ff-text-secondary)] mb-4">The journal entry will be reversed (net-zero contra) and any linked bank transaction returns to the review queue.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDismissJeId(null)} className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
              <button onClick={() => {
                const jeId = dismissJeId;
                setDismissJeId(null);
                apiFetch(`/api/accounting/provisional/${jeId}/dismiss`, { method: 'POST' })
                  .then(async (res) => {
                    const json = await res.json();
                    if (!res.ok || !json.success) throw new Error(json.error?.message ?? 'Failed to dismiss');
                    setToast({ msg: 'Provisional entry reversed — linked bank transaction returned to the review queue.', kind: 'ok' });
                    void load();
                  })
                  .catch((err: unknown) => setToast({ msg: err instanceof Error ? err.message : 'Failed to dismiss entry', kind: 'err' }));
              }}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-700 text-white font-medium">Dismiss &amp; reverse</button>
            </div>
          </div>
        </div>
      )}

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
