/**
 * Supplier Statement Reconciliation Detail — PRD-05 Phase 7
 * Header card + statement lines table + missing invoices section.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, AlertCircle, RefreshCw, CheckCircle2, X, ChevronDown, ChevronUp, ArrowLeft, ExternalLink } from 'lucide-react';

type ReconStatus = 'unreconciled' | 'reconciled' | 'disputed' | 'archived';
type MismatchReason = 'missing_in_isaflow' | 'missing_in_statement' | 'amount_diff' | 'date_diff' | null;

interface StatementLine {
  id: string; lineDate: string | null; reference: string | null; description: string | null;
  debit: number; credit: number; runningBalance: number | null;
  matchedSupplierInvoiceId: string | null; matchedInvoiceNumber: string | null;
  matchConfidence: number | null; mismatchReason: MismatchReason;
}

interface MissingInvoice {
  invoiceId: string; invoiceNumber: string; invoiceDate: string; totalAmount: number;
}

interface SupplierStatementReconciliation {
  id: string; supplierId: string; supplierName: string;
  statementDate: string; periodStart: string | null; periodEnd: string | null;
  supplierBalance: number; isaflowBalance: number; variance: number;
  status: ReconStatus;
  missingInIsaflowCount: number; missingInStatementCount: number; amountDiffCount: number;
  lines: StatementLine[]; missingInvoices: MissingInvoice[];
  createdAt: string; reconciledAt: string | null;
}

type Toast = { msg: string; kind: 'ok' | 'err' } | null;

function fmtZAR(n: number) {
  return 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
}

function varianceCls(variance: number) {
  const abs = Math.abs(variance);
  if (abs <= 0.01) return 'text-teal-400';
  if (abs <= 100) return 'text-amber-400';
  return 'text-red-400';
}

function MatchStatusCell({ line }: { line: StatementLine }) {
  const conf = line.matchConfidence ?? 0;
  if (line.mismatchReason === 'missing_in_isaflow') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-red-500/15 text-red-400 border-red-500/30">Missing in IsaFlow</span>
        <div className="relative group/tip">
          <button disabled className="text-xs text-[var(--ff-text-tertiary)] border border-[var(--ff-border-light)] px-2 py-0.5 rounded opacity-50 cursor-not-allowed">Create invoice</button>
          <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 px-2 py-1 rounded text-xs bg-gray-900 text-gray-200 whitespace-nowrap opacity-0 group-hover/tip:opacity-100 transition-opacity z-10">
            Phase 7 scope — create manually for now
          </span>
        </div>
      </div>
    );
  }
  if (line.mismatchReason === 'amount_diff') return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-amber-500/15 text-amber-400 border-amber-500/30">Amount diff</span>;
  if (line.mismatchReason === 'date_diff') return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-amber-500/15 text-amber-400 border-amber-500/30">Date diff</span>;
  if (conf >= 0.95) return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-teal-500/15 text-teal-400 border-teal-500/30">Matched</span>;
  if (conf >= 0.70) return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-amber-500/15 text-amber-400 border-amber-500/30">Fuzzy match</span>;
  return <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-slate-600/30 text-slate-400 border-slate-500/30">Unmatched</span>;
}

const TH = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--ff-text-tertiary)]';

export default function SupplierStatementDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const reconId = typeof id === 'string' ? id : null;

  const [recon, setRecon] = useState<SupplierStatementReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast>(null);
  const [rematching, setRematching] = useState(false);
  const [marking, setMarking] = useState(false);
  const [missingOpen, setMissingOpen] = useState(false);

  const showToast = useCallback((msg: string, kind: 'ok' | 'err') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const load = useCallback(async () => {
    if (!reconId) return;
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/accounting/supplier-statements/${reconId}`);
      const json = await res.json() as { data?: SupplierStatementReconciliation; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load reconciliation'); return; }
      const data = json.data ?? null;
      setRecon(data);
      if (data && data.missingInStatementCount > 0) setMissingOpen(true);
    } catch { setError('Network error loading reconciliation'); }
    finally { setLoading(false); }
  }, [reconId]);

  useEffect(() => { void load(); }, [load]);

  const handleRematch = useCallback(async () => {
    if (!reconId) return;
    setRematching(true);
    try {
      const res = await apiFetch(`/api/accounting/supplier-statements/${reconId}/rematch`, { method: 'POST' });
      const json = await res.json() as { data?: SupplierStatementReconciliation; error?: string };
      if (!res.ok) { showToast(json.error ?? 'Rematch failed', 'err'); return; }
      setRecon(json.data ?? null);
      showToast('Rematch complete', 'ok');
    } catch { showToast('Network error during rematch', 'err'); }
    finally { setRematching(false); }
  }, [reconId, showToast]);

  const handleMarkReconciled = useCallback(async () => {
    if (!reconId) return;
    setMarking(true);
    try {
      const res = await apiFetch(`/api/accounting/supplier-statements/${reconId}/mark-reconciled`, { method: 'POST' });
      if (!res.ok) { showToast('Failed to mark reconciled', 'err'); return; }
      showToast('Marked as reconciled', 'ok');
      void load();
    } catch { showToast('Network error', 'err'); }
    finally { setMarking(false); }
  }, [reconId, load, showToast]);

  const canReconcile = recon
    ? Math.abs(recon.variance) <= 0.01 && recon.missingInIsaflowCount === 0 && recon.amountDiffCount === 0
    : false;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          <button onClick={() => router.push('/accounting/ap/supplier-statements')} className="flex items-center gap-1.5 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-3 transition-colors">
            <ArrowLeft className="h-4 w-4" /> Back to statements
          </button>
          <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{recon?.supplierName ?? 'Supplier Statement'}</h1>
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm"><AlertCircle className="h-4 w-4" />{error}</div>}

          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-indigo-400" /></div>
          ) : recon ? (
            <>
              {/* Header card */}
              <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div><p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Statement date</p><p className="font-medium text-[var(--ff-text-primary)]">{fmtDate(recon.statementDate)}</p></div>
                  <div><p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Period</p><p className="text-[var(--ff-text-primary)]">{recon.periodStart || recon.periodEnd ? `${fmtDate(recon.periodStart)} – ${fmtDate(recon.periodEnd)}` : '—'}</p></div>
                  <div><p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Supplier balance</p><p className="font-mono text-[var(--ff-text-primary)]">{fmtZAR(recon.supplierBalance)}</p></div>
                  <div><p className="text-xs text-[var(--ff-text-tertiary)] mb-1">IsaFlow balance</p><p className="font-mono text-[var(--ff-text-primary)]">{fmtZAR(recon.isaflowBalance)}</p></div>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[var(--ff-border-light)]">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-[var(--ff-text-tertiary)]">Variance</span>
                    <span className={`text-2xl font-bold font-mono ${varianceCls(recon.variance)}`}>{fmtZAR(recon.variance)}</span>
                  </div>
                  {recon.missingInIsaflowCount > 0 && <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/20 text-red-400">{recon.missingInIsaflowCount} missing in IsaFlow</span>}
                  {recon.amountDiffCount > 0 && <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-400">{recon.amountDiffCount} amount diff</span>}
                  {recon.missingInStatementCount > 0 && <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-600/30 text-slate-400">{recon.missingInStatementCount} missing in statement</span>}
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button onClick={handleRematch} disabled={rematching}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 border border-amber-500/30 disabled:opacity-50 transition-colors">
                    <RefreshCw className={`h-4 w-4 ${rematching ? 'animate-spin' : ''}`} />
                    {rematching ? 'Rematching…' : 'Rematch'}
                  </button>
                  <div className="relative group/tip">
                    <button onClick={handleMarkReconciled} disabled={!canReconcile || marking || recon.status === 'reconciled'}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-teal-600/20 hover:bg-teal-600/30 text-teal-400 border border-teal-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                      <CheckCircle2 className="h-4 w-4" />
                      {marking ? 'Saving…' : 'Mark reconciled'}
                    </button>
                    {!canReconcile && (
                      <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 px-2 py-1 rounded text-xs bg-gray-900 text-gray-200 whitespace-nowrap opacity-0 group-hover/tip:opacity-100 transition-opacity z-10">
                        Variance must be ≤ R0.01 and no mismatches
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Statement lines */}
              <div>
                <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-2">Statement lines</h2>
                <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
                  <table className="w-full text-sm min-w-[820px]">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)]">
                        <th className={TH}>Date</th><th className={TH}>Reference</th>
                        <th className={TH}>Description</th><th className={`${TH} text-right`}>Debit</th>
                        <th className={`${TH} text-right`}>Credit</th><th className={TH}>Match</th><th className={TH}>Invoice #</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recon.lines.map(line => (
                        <tr key={line.id} className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5">
                          <td className="px-4 py-2.5 text-xs font-mono text-[var(--ff-text-secondary)]">{fmtDate(line.lineDate)}</td>
                          <td className="px-4 py-2.5 text-xs text-[var(--ff-text-tertiary)]">{line.reference ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-[var(--ff-text-primary)] max-w-[200px] truncate" title={line.description ?? undefined}>{line.description ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs font-mono text-right text-[var(--ff-text-secondary)]">{line.debit > 0 ? fmtZAR(line.debit) : '—'}</td>
                          <td className="px-4 py-2.5 text-xs font-mono text-right text-teal-400">{line.credit > 0 ? fmtZAR(line.credit) : '—'}</td>
                          <td className="px-4 py-2.5"><MatchStatusCell line={line} /></td>
                          <td className="px-4 py-2.5 text-xs text-[var(--ff-text-secondary)]">
                            {line.matchedInvoiceNumber && line.matchedSupplierInvoiceId ? (
                              <button onClick={() => router.push(`/accounting/supplier-invoices/${line.matchedSupplierInvoiceId}`)}
                                className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors">
                                {line.matchedInvoiceNumber}<ExternalLink className="h-3 w-3" />
                              </button>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Missing invoices section */}
              {recon.missingInvoices.length > 0 && (
                <div>
                  <button onClick={() => setMissingOpen(v => !v)}
                    className="flex items-center gap-2 text-sm font-semibold text-[var(--ff-text-primary)] mb-2 hover:text-[var(--ff-text-secondary)] transition-colors">
                    {missingOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    Invoices not on statement ({recon.missingInvoices.length})
                  </button>
                  {missingOpen && (
                    <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
                      <table className="w-full text-sm min-w-[500px]">
                        <thead>
                          <tr className="border-b border-[var(--ff-border-light)]">
                            <th className={TH}>Invoice #</th><th className={TH}>Date</th>
                            <th className={`${TH} text-right`}>Amount</th><th className={TH}>Tag</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recon.missingInvoices.map(inv => (
                            <tr key={inv.invoiceId}
                              onClick={() => router.push(`/accounting/supplier-invoices/${inv.invoiceId}`)}
                              className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5 cursor-pointer transition-colors">
                              <td className="px-4 py-2.5 text-xs font-medium text-indigo-400">{inv.invoiceNumber}</td>
                              <td className="px-4 py-2.5 text-xs font-mono text-[var(--ff-text-secondary)]">{fmtDate(inv.invoiceDate)}</td>
                              <td className="px-4 py-2.5 text-xs font-mono text-right text-[var(--ff-text-secondary)]">{fmtZAR(inv.totalAmount)}</td>
                              <td className="px-4 py-2.5"><span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-slate-600/30 text-slate-400 border-slate-500/30">missing in statement</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

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
