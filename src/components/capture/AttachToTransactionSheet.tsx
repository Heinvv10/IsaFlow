/**
 * Mobile-first post-upload step (Workstream G): pick a bank transaction to
 * attach the just-captured document(s) to. Lists recent transactions
 * (searchable by description/reference) via GET /api/accounting/bank-transactions;
 * attach posts the existing document-capture-action match_bank_tx per document.
 *
 * Error unwrap rule: apiResponse error envelope is {error:{code,message}} —
 * only ever render json.error?.message / json.message, never json.error.
 *
 * Response shape: GET /api/accounting/bank-transactions returns
 * { data: { transactions: BankTransaction[], total: number } }
 * where BankTransaction uses camelCase fields (transactionDate, description, amount).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Search, Link2, Loader2, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

interface BankTxOption {
  id: string;
  transactionDate: string;
  description?: string;
  amount: number;
}

interface AttachToTransactionSheetProps {
  documentIds: string[];
  onDone: () => void; // called after successful attach OR skip
}

function formatAmount(a: number): string {
  return formatMoney(a);
}

function formatDate(d: string): string {
  return formatDisplayDate(d, '');
}

export function AttachToTransactionSheet({ documentIds, onDone }: AttachToTransactionSheetProps) {
  const [search, setSearch] = useState('');
  const [txs, setTxs] = useState<BankTxOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Monotonic sequence guard: a slow earlier response must not clobber the
  // result of a later request (out-of-order resolution during fast typing).
  const loadSeqRef = useRef(0);

  const load = useCallback(async (q: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (q.trim()) params.set('search', q.trim());
      const res = await apiFetch(`/api/accounting/bank-transactions?${params.toString()}`);
      await assertOk(res, 'Could not load the transactions - try again');
      const json = await res.json() as { data?: { transactions?: BankTxOption[] } };
      if (seq !== loadSeqRef.current) return;
      setTxs(json.data?.transactions ?? []);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setTxs([]);
      setError(apiErrorMessage(err, 'Could not load the transactions - try again'));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(search), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [search, load]);

  // Lock body scroll while the sheet is open (mobile bottom-sheet behavior).
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const attach = useCallback(async (txId: string) => {
    setAttaching(txId);
    let attached = 0;
    try {
      for (const docId of documentIds) {
        const res = await apiFetch('/api/accounting/document-capture-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: docId, action: 'match_bank_tx', data: { bankTxId: txId } }),
        });
        await assertOk(res, 'Could not attach the document - try again');
        attached++;
      }
      toast.success(documentIds.length > 1 ? `${documentIds.length} documents attached` : 'Attached to transaction');
      onDone();
    } catch (err) {
      const why = apiErrorMessage(err, 'Could not attach the document - try again');
      toast.error(attached > 0 ? `${attached} of ${documentIds.length} documents attached. ${why}` : why);
    } finally {
      setAttaching(null);
    }
  }, [documentIds, onDone]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" role="dialog" aria-modal="true" aria-label="Attach to a bank transaction">
      <div className="w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--ff-border-primary)]">
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-teal-500" />
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Attach to a transaction?</h2>
          </div>
          <button onClick={onDone} aria-label="Skip attaching" className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
            <X className="h-5 w-5 text-[var(--ff-text-secondary)]" />
          </button>
        </div>

        <div className="px-5 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search description or amount…"
              className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] focus:outline-none focus:border-teal-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
          ) : error ? (
            <p className="text-sm text-red-400 text-center py-8">{error}</p>
          ) : txs.length === 0 ? (
            <p className="text-sm text-[var(--ff-text-secondary)] text-center py-8">No transactions found.</p>
          ) : (
            txs.map((tx) => (
              <button
                key={tx.id}
                onClick={() => void attach(tx.id)}
                disabled={attaching !== null}
                className="w-full flex items-center justify-between gap-3 px-3 py-3 rounded-lg hover:bg-[var(--ff-bg-tertiary)] active:bg-[var(--ff-bg-tertiary)] text-left disabled:opacity-50"
              >
                <div className="min-w-0">
                  <p className="text-sm text-[var(--ff-text-primary)] truncate">{tx.description ?? '(no description)'}</p>
                  <p className="text-xs text-[var(--ff-text-tertiary)]">{formatDate(tx.transactionDate)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-sm font-medium text-[var(--ff-text-primary)]">{formatAmount(tx.amount)}</span>
                  {attaching === tx.id ? <Loader2 className="h-4 w-4 animate-spin text-teal-500" /> : <CheckCircle2 className="h-4 w-4 text-[var(--ff-text-tertiary)]" />}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--ff-border-primary)]">
          <button onClick={onDone} className="w-full py-3 rounded-xl border border-[var(--ff-border-primary)] text-sm font-medium text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">
            Skip — keep in inbox
          </button>
        </div>
      </div>
    </div>
  );
}
