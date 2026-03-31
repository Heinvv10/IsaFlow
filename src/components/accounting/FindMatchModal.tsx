/**
 * Find & Match Modal — manually match a bank transaction to a candidate
 * (supplier invoice, purchase order, or GL journal line).
 * Fetches scored candidates from /api/accounting/bank-match-candidates and
 * confirms the selection via /api/accounting/bank-match-confirm.
 */

import { useState, useEffect } from 'react';
import { X, Search, CheckCircle, FileText, ShoppingCart, BookOpen, Loader2, Users } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import type { MatchCandidate, CandidateType } from '@/modules/accounting/types/bank-match.types';

interface Transaction {
  id: string;
  description?: string;
  amount: number;
  transactionDate: string;
}

interface Props {
  transaction: Transaction;
  onClose: () => void;
  /** Called after a successful match — parent should refresh the transaction list */
  onMatch: (candidateType: CandidateType, candidateId: string) => void;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}

const TYPE_META: Record<CandidateType, { label: string; icon: typeof FileText; colour: string }> = {
  supplier_invoice: { label: 'Supplier Inv', icon: FileText, colour: 'text-blue-400 bg-blue-400/10' },
  customer_invoice: { label: 'Customer Inv', icon: Users, colour: 'text-teal-400 bg-teal-400/10' },
  purchase_order: { label: 'PO', icon: ShoppingCart, colour: 'text-amber-400 bg-amber-400/10' },
  journal_line: { label: 'Journal', icon: BookOpen, colour: 'text-purple-400 bg-purple-400/10' },
};

const GROUP_ORDER: CandidateType[] = ['customer_invoice', 'supplier_invoice', 'purchase_order', 'journal_line'];
const GROUP_TITLES: Record<CandidateType, string> = {
  customer_invoice: 'Customer Invoices',
  supplier_invoice: 'Supplier Invoices',
  purchase_order: 'Purchase Orders',
  journal_line: 'Journal Lines',
};

export function FindMatchModal({ transaction, onClose, onMatch }: Props) {
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MatchCandidate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;

    const fetchCandidates = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(
          `/api/accounting/bank-match-candidates?bankTransactionId=${encodeURIComponent(transaction.id)}`,
        );
        const json = await res.json() as { success: boolean; data?: { candidates: MatchCandidate[] }; error?: { message: string } };
        if (!res.ok || !json.success) {
          throw new Error(json.error?.message ?? 'Failed to load candidates');
        }
        if (!cancelled) {
          setCandidates(json.data?.candidates ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load candidates');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchCandidates();
    return () => { cancelled = true; };
  }, [transaction.id]);

  const filtered = candidates.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.label.toLowerCase().includes(q) || fmtCurrency(c.amount).includes(q);
  });

  const grouped = GROUP_ORDER.reduce<Record<CandidateType, MatchCandidate[]>>((acc, type) => {
    acc[type] = filtered.filter(c => c.type === type);
    return acc;
  }, { customer_invoice: [], supplier_invoice: [], purchase_order: [], journal_line: [] });

  const handleConfirm = async () => {
    if (!selected) return;
    setConfirming(true);
    try {
      const res = await apiFetch('/api/accounting/bank-match-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankTransactionId: transaction.id,
          candidateType: selected.type,
          candidateId: selected.id,
        }),
      });
      const json = await res.json() as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message ?? 'Match failed');
      }
      const matchedMeta = TYPE_META[selected.type];
      notify.success(`Matched to ${matchedMeta?.label ?? selected.type}: ${selected.label}`);
      onMatch(selected.type, selected.id);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Match confirmation failed');
    } finally {
      setConfirming(false);
    }
  };

  const txIsExact = (c: MatchCandidate) => Math.abs(Math.abs(c.amount) - Math.abs(transaction.amount)) < 0.01;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--ff-border-light)]">
          <div className="p-2 rounded-lg bg-teal-500/10">
            <Search className="h-4 w-4 text-teal-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Find &amp; Match</h2>
            <p className="text-xs text-[var(--ff-text-tertiary)] truncate">
              {transaction.transactionDate} &middot; {transaction.description ?? 'No description'}
            </p>
          </div>
          <div className="text-right mr-2">
            <p className={`text-base font-bold font-mono ${transaction.amount < 0 ? 'text-red-400' : 'text-teal-400'}`}>
              {fmtCurrency(transaction.amount)}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search bar */}
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />
            <input
              type="text"
              placeholder="Filter candidates…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Candidate list */}
        <div className="overflow-y-auto flex-1 px-4 pb-3 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-10 gap-2 text-[var(--ff-text-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Loading candidates…</span>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 py-4 text-center">{error}</div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="text-xs text-[var(--ff-text-tertiary)] py-4 text-center">
              No candidates found. Try importing the corresponding document first.
            </div>
          )}

          {!loading && !error && GROUP_ORDER.map(type => {
            // Safe non-null lookups — GROUP_ORDER and TYPE_META are both keyed by CandidateType
            const group: MatchCandidate[] = grouped[type] ?? [];
            if (group.length === 0) return null;
            const meta = TYPE_META[type]!;
            const Icon = meta.icon;
            return (
              <div key={type}>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ff-text-tertiary)] mb-1.5">
                  {GROUP_TITLES[type]}
                </p>
                <div className="space-y-1">
                  {group.map(c => {
                    const exact = txIsExact(c);
                    const isSelected = selected?.id === c.id && selected?.type === c.type;
                    return (
                      <button
                        key={`${c.type}-${c.id}`}
                        onClick={() => setSelected(isSelected ? null : c)}
                        className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                          isSelected
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-border-medium)]'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {/* Type badge */}
                          <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${meta.colour}`}>
                            <Icon className="h-2.5 w-2.5" />
                            {meta.label}
                          </span>

                          {/* Label */}
                          <span className="flex-1 text-xs text-[var(--ff-text-primary)] truncate">{c.label}</span>

                          {/* Amount */}
                          <span className={`text-xs font-mono font-semibold ${exact ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
                            {fmtCurrency(c.amount)}
                            {exact && <span className="ml-1 text-[10px] text-teal-400">exact</span>}
                          </span>
                        </div>

                        {/* Date + score bar */}
                        <div className="flex items-center gap-3 mt-1.5">
                          <span className="text-[10px] text-[var(--ff-text-tertiary)]">{c.date}</span>
                          <div className="flex-1 h-1 rounded-full bg-[var(--ff-bg-secondary)] overflow-hidden">
                            <div
                              className="h-full rounded-full bg-blue-500"
                              style={{ width: `${Math.min(100, c.score)}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-[var(--ff-text-tertiary)] w-8 text-right">{c.score}pt</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--ff-border-light)] px-5 py-3 flex items-center justify-between">
          <p className="text-xs text-[var(--ff-text-tertiary)]">
            {selected
              ? `Selected: ${TYPE_META[selected.type]?.label ?? selected.type} — ${selected.label}`
              : 'Select a candidate to match'}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)]"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!selected || confirming}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-medium bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white transition-colors"
            >
              {confirming
                ? <><Loader2 className="h-3 w-3 animate-spin" /> Confirming…</>
                : <><CheckCircle className="h-3 w-3" /> Confirm Match</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
