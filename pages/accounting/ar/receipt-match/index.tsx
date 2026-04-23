/**
 * Receipt → Invoice Auto-Match queue (PRD-06 Phase 4).
 *
 * Lists bank transactions with status='imported' and amount > 0 (receipts),
 * fetches the top-5 scored candidates for each, surfaces the top match
 * inline with a confidence bar + "Confirm" action.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, Banknote, CheckCircle, ArrowRight, Info } from 'lucide-react';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface BankTxRow {
  id: string;
  transactionDate: string;
  amount: number;
  description: string;
  reference: string;
  bankAccountId?: string | null;
}

interface CandidateSignals {
  paymentReferenceExact: boolean;
  paymentReferencePartial: boolean;
  portalViewBoost: number;
  trigramSimilarity?: number;
  scoreBreakdown: {
    reference: number;
    portalView: number;
    amount: number;
    date: number;
    description: number;
  };
}

interface Candidate {
  type: 'customer_invoice';
  id: string;
  label: string;
  amount: number;
  date: string;
  score: number;
  matchReason?: string;
  signals?: CandidateSignals;
}

interface ShortlistResponse {
  candidates: Candidate[];
  bankTransaction: BankTxRow;
}

export default function ReceiptMatchQueuePage() {
  const [receipts, setReceipts] = useState<BankTxRow[]>([]);
  const [shortlists, setShortlists] = useState<Record<string, Candidate[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadReceipts = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const res = await apiFetch('/api/accounting/bank-transactions?status=imported&limit=50');
      const json = await res.json();
      const all: BankTxRow[] = json?.data?.transactions ?? json?.transactions ?? [];
      const onlyReceipts = all.filter((t) => Number(t.amount) > 0);
      setReceipts(onlyReceipts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load receipts');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadShortlist = useCallback(async (bankTxId: string) => {
    try {
      const res = await apiFetch(`/api/accounting/ar/receipt-match/${bankTxId}`);
      const json = (await res.json()) as { data?: ShortlistResponse };
      const candidates = json?.data?.candidates ?? [];
      setShortlists((prev) => ({ ...prev, [bankTxId]: candidates }));
    } catch (err) {
      setShortlists((prev) => ({ ...prev, [bankTxId]: [] }));
    }
  }, []);

  useEffect(() => {
    void loadReceipts();
  }, [loadReceipts]);

  useEffect(() => {
    for (const tx of receipts) {
      if (!(tx.id in shortlists)) void loadShortlist(tx.id);
    }
  }, [receipts, shortlists, loadShortlist]);

  const handleConfirm = async (tx: BankTxRow, candidate: Candidate) => {
    if (confirming) return;
    setConfirming(tx.id);
    try {
      const res = await apiFetch('/api/accounting/ar/receipt-match/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankTxId: tx.id,
          customerInvoiceId: candidate.id,
          amount: Math.min(Number(tx.amount), Number(candidate.amount)),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error?.message ?? json?.message ?? 'Confirm failed');
      }
      setReceipts((prev) => prev.filter((r) => r.id !== tx.id));
      setShortlists((prev) => {
        const next = { ...prev };
        delete next[tx.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm match');
    } finally {
      setConfirming(null);
    }
  };

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
            <Banknote className="w-6 h-6 text-emerald-600" />
            Receipt Auto-Match
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Incoming customer receipts awaiting allocation. The top candidate uses invoice-reference hits,
            portal view history, and amount/date signals — confirm to allocate in one click.
          </p>
        </div>

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : receipts.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <CheckCircle className="w-12 h-12 mx-auto mb-3 text-emerald-400" />
            <p className="text-lg font-medium text-slate-900">All receipts allocated</p>
            <p className="text-sm mt-1">No imported receipts waiting for a match.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {receipts.map((tx) => {
              const list = shortlists[tx.id];
              const top = list?.[0];
              const confidence = top ? Math.min(100, Math.round((top.score / 150) * 100)) : 0;
              const isConfirmingThis = confirming === tx.id;

              return (
                <div key={tx.id} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-xs text-slate-500 uppercase tracking-wide">
                        {formatDate(tx.transactionDate)} • Receipt
                      </div>
                      <div className="text-lg font-semibold text-slate-900 mt-1 truncate">
                        {tx.description || tx.reference || '—'}
                      </div>
                      {tx.reference && tx.reference !== tx.description && (
                        <div className="text-xs text-slate-500 mt-0.5">Ref: {tx.reference}</div>
                      )}
                    </div>
                    <div className="text-xl font-bold text-emerald-600 whitespace-nowrap">
                      {formatCurrency(Number(tx.amount))}
                    </div>
                  </div>

                  {list === undefined ? (
                    <div className="mt-4 text-xs text-slate-400 flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" /> Scoring candidates…
                    </div>
                  ) : top ? (
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium text-slate-900">{top.label}</span>
                            <span className="text-slate-500">
                              Balance {formatCurrency(top.amount)}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  confidence >= 75
                                    ? 'bg-emerald-500'
                                    : confidence >= 50
                                      ? 'bg-amber-500'
                                      : 'bg-slate-400'
                                }`}
                                style={{ width: `${confidence}%` }}
                              />
                            </div>
                            <span className="text-xs font-medium text-slate-600 w-10 text-right">{confidence}%</span>
                          </div>
                          {top.matchReason && (
                            <div className="mt-1.5 text-xs text-slate-500 flex items-center gap-1">
                              <Info className="w-3 h-3" />
                              {top.matchReason}
                            </div>
                          )}
                          {top.signals && (
                            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                              {top.signals.paymentReferenceExact && (
                                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                                  exact ref +{top.signals.scoreBreakdown.reference}
                                </span>
                              )}
                              {top.signals.paymentReferencePartial && (
                                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                                  fuzzy ref +{top.signals.scoreBreakdown.reference}
                                </span>
                              )}
                              {top.signals.portalViewBoost > 0 && (
                                <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">
                                  portal view +{top.signals.scoreBreakdown.portalView}
                                </span>
                              )}
                              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                                amount +{top.signals.scoreBreakdown.amount}
                              </span>
                              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                                date +{top.signals.scoreBreakdown.date}
                              </span>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleConfirm(tx, top)}
                          disabled={isConfirmingThis}
                          className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium whitespace-nowrap"
                        >
                          {isConfirmingThis ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <>
                              Confirm <ArrowRight className="w-4 h-4" />
                            </>
                          )}
                        </button>
                      </div>

                      {list.length > 1 && (
                        <details className="mt-3">
                          <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                            {list.length - 1} more candidate{list.length - 1 === 1 ? '' : 's'}
                          </summary>
                          <div className="mt-2 space-y-1.5">
                            {list.slice(1).map((c) => (
                              <div
                                key={c.id}
                                className="flex items-center justify-between text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded"
                              >
                                <span className="truncate">{c.label}</span>
                                <div className="flex items-center gap-3">
                                  <span className="text-slate-400">{formatCurrency(c.amount)}</span>
                                  <span className="font-medium">score {c.score}</span>
                                  <button
                                    type="button"
                                    onClick={() => void handleConfirm(tx, c)}
                                    disabled={isConfirmingThis}
                                    className="text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                                  >
                                    Use
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  ) : (
                    <div className="mt-4 text-xs text-slate-500 border-t border-slate-100 pt-4">
                      No matching invoice found — allocate manually from bank reconciliation.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
