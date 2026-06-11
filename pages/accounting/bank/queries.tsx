/**
 * Client Queries — WhatsApp query resolution queue (PRD-07)
 * Route: /accounting/bank/queries
 *
 * Lists bank-tx WhatsApp queries; actionable queue defaults to "replied" tab.
 * Supports resolve (sent|replied) and cancel (sent only) with settle+retry
 * to guard against the withAuth pre-COMMIT flush race.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { MessageSquare, AlertCircle, Loader2, CheckCircle2, X } from 'lucide-react';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
import { StatusBadge, ExpandableText, QueryRowActions } from '@/components/accounting/bank/QueryRow';
import type { BankTxQueryRow } from '@/components/accounting/bank/QueryRow';

// ── Types ─────────────────────────────────────────────────────────────────────

type StatusFilter = 'replied' | 'sent' | 'resolved' | 'all';
type Toast = { msg: string; kind: 'ok' | 'err' } | null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtZAR = (n: number) =>
  'R ' + Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (s: string | Date | null) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
};

const fmtDateTime = (s: string | Date | null) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' }); } catch { return String(s); }
};

/** Guard against withAuth pre-COMMIT flush race — wait before refetching. */
const settle = () => new Promise<void>((r) => setTimeout(r, 600));

// ── Tab config ────────────────────────────────────────────────────────────────

const TABS: { id: StatusFilter; label: string; param: string | null; empty: string }[] = [
  { id: 'replied', label: 'Replied', param: 'replied', empty: 'No replies waiting — all caught up.' },
  { id: 'sent',    label: 'Open',    param: 'sent',    empty: 'No open queries awaiting a reply.' },
  { id: 'resolved', label: 'Resolved', param: 'resolved', empty: 'No resolved queries yet.' },
  { id: 'all',     label: 'All',     param: null,      empty: 'No client queries have been sent yet.' },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ClientQueriesPage() {
  const [tab, setTab] = useState<StatusFilter>('replied');
  const [rows, setRows] = useState<BankTxQueryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [attachTxId, setAttachTxId] = useState<string | null>(null);
  const [attachDesc, setAttachDesc] = useState<string | undefined>(undefined);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const load = useCallback(async (retry = false) => {
    if (!retry) setLoading(true);
    setError('');
    const param = TABS.find(t => t.id === tab)?.param;
    const url = `/api/accounting/bank-tx-queries${param ? `?status=${param}` : ''}`;
    try {
      let res = await apiFetch(url);
      if (!res.ok) {
        await settle();
        res = await apiFetch(url);
      }
      const json = await res.json() as { data?: BankTxQueryRow[]; message?: string; error?: { message?: string } };
      if (!res.ok) { setError(json.message ?? json.error?.message ?? 'Failed to load queries'); return; }
      setRows(json.data ?? []);
    } catch (err) {
      log.error('Failed to load bank-tx queries', { err }, 'client-queries-page');
      setError('Network error loading queries');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleAction = useCallback(async (id: string, action: 'resolve' | 'cancel') => {
    if (acting) return;
    setActing(id);
    try {
      const res = await apiFetch(`/api/accounting/bank-tx-queries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json() as { message?: string; error?: { message?: string } };
      if (!res.ok) { setToast({ msg: json.message ?? json.error?.message ?? `${action} failed`, kind: 'err' }); return; }
      setToast({ msg: action === 'resolve' ? 'Query marked resolved' : 'Query cancelled', kind: 'ok' });
      await settle();
      await load(true);
    } catch (err) {
      log.error('Bank-tx query action failed', { id, action, err }, 'client-queries-page');
      setToast({ msg: 'Network error', kind: 'err' });
    } finally {
      setActing(null);
    }
  }, [acting, load]);

  const handleResolve = useCallback((id: string) => { void handleAction(id, 'resolve'); }, [handleAction]);
  const handleCancel = useCallback((id: string, desc: string | null) => {
    const label = desc ? `"${desc.slice(0, 60)}"` : 'this query';
    if (!window.confirm(`Cancel ${label}? This cannot be undone.`)) return;
    void handleAction(id, 'cancel');
  }, [handleAction]);
  const handleViewSlips = useCallback((txId: string, desc: string | undefined) => {
    setAttachTxId(txId); setAttachDesc(desc);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const currentTab = TABS.find(t => t.id === tab)!;
  const toastCls = toast?.kind === 'ok'
    ? 'bg-teal-900/80 text-teal-200 border-teal-700'
    : 'bg-red-900/80 text-red-200 border-red-700';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <MessageSquare className="h-5 w-5 text-teal-400" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Client Queries</h1>
          </div>
          <p className="text-sm text-[var(--ff-text-secondary)] ml-12">
            WhatsApp queries to clients about bank transactions.
          </p>
        </div>

        {/* ── Filter tabs ──────────────────────────────────────────────────── */}
        <div className="px-6 pt-4 pb-0 flex items-center gap-2 border-b border-[var(--ff-border-light)]">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                tab === t.id
                  ? 'border-teal-400 text-teal-300'
                  : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="px-6 py-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-4">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-teal-400" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-20 max-w-md mx-auto">
              <MessageSquare className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3 opacity-40" />
              <p className="text-[var(--ff-text-secondary)] text-sm">{currentTab.empty}</p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)] text-xs uppercase">
                    <th className="px-4 py-3 text-left font-medium">Date</th>
                    <th className="px-4 py-3 text-left font-medium">Account / Description</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 text-left font-medium">To</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Sent</th>
                    <th className="px-4 py-3 text-left font-medium">Reply / Message</th>
                    <th className="px-4 py-3 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5 transition-colors align-top">
                      <td className="px-4 py-3 font-mono text-xs text-[var(--ff-text-secondary)] whitespace-nowrap">{fmtDate(r.transaction_date)}</td>
                      <td className="px-4 py-3 max-w-[180px]">
                        <p className="text-xs font-medium text-[var(--ff-text-primary)] line-clamp-2">{r.tx_description || '—'}</p>
                        <p className="text-[10px] text-[var(--ff-text-tertiary)]">{r.bank_account_name ?? '—'}</p>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-[var(--ff-text-secondary)] whitespace-nowrap">{fmtZAR(r.amount)}</td>
                      <td className="px-4 py-3 text-xs text-[var(--ff-text-secondary)] whitespace-nowrap">{r.to_number}</td>
                      <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                      <td className="px-4 py-3 text-[10px] text-[var(--ff-text-tertiary)] whitespace-nowrap">{fmtDateTime(r.sent_at)}</td>
                      <td className="px-4 py-3 max-w-[280px] space-y-1">
                        {r.reply_text && (
                          <div>
                            <span className="text-[10px] uppercase text-teal-400 font-medium mr-1">Reply:</span>
                            <ExpandableText text={r.reply_text} limit={150} label="Read more" />
                          </div>
                        )}
                        <div>
                          <ExpandableText text={r.message_body} limit={80} label="Show message" />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <QueryRowActions
                          row={r}
                          acting={acting}
                          onViewSlips={handleViewSlips}
                          onResolve={handleResolve}
                          onCancel={handleCancel}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {attachTxId && (
        <BankTxAttachmentsModal
          bankTransactionId={attachTxId}
          transactionDescription={attachDesc}
          onClose={() => { setAttachTxId(null); setAttachDesc(undefined); }}
        />
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg border text-sm shadow-xl ${toastCls}`}>
          {toast.kind === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          <span>{toast.msg}</span>
          <button onClick={() => setToast(null)} className="ml-2 opacity-60 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </AppLayout>
  );
}
