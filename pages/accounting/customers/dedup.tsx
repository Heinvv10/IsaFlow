/**
 * Customer Deduplication Page
 * Route: /accounting/customers/dedup
 *
 * Scans for duplicate customers (same email, VAT number, or similar name)
 * and lets the user merge the duplicate into the primary record.
 * All transactions are re-parented to the surviving customer.
 */

import { useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users2, Loader2, AlertCircle, Search, Info, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { DuplicatePair } from '@/types/customer-duplicates';
import {
  ConfirmModal,
  Toast,
  PairRow,
} from '@/components/accounting/CustomerDedupComponents';

interface PendingMerge {
  keepId: string;
  mergeId: string;
  keepName: string;
  mergeName: string;
}

export default function CustomerDedupPage() {
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [scanned, setScanned] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  const [pending, setPending] = useState<PendingMerge | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const scan = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-duplicates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: DuplicatePair[] };
      setPairs(json.data ?? []);
      setScanned(true);
    } catch {
      setError('Failed to scan for duplicates. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleMergeConfirm = useCallback(async () => {
    if (!pending) return;
    setIsMerging(true);
    try {
      const res = await apiFetch('/api/accounting/customer-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: pending.keepId, source_id: pending.mergeId }),
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      // Remove all pairs that involved either customer
      setPairs((prev) =>
        prev.filter(
          (p) =>
            p.id_a !== pending.mergeId &&
            p.id_b !== pending.mergeId
        )
      );
      showToast(`"${pending.mergeName}" merged into "${pending.keepName}"`, 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Merge failed: ${msg}`, 'error');
    } finally {
      setIsMerging(false);
      setPending(null);
    }
  }, [pending, showToast]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users2 className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
                  Customer Deduplication
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Detect and merge duplicate customer records
                </p>
              </div>
            </div>
            <button
              onClick={scan}
              disabled={isLoading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {isLoading
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Search className="h-4 w-4" />
              }
              {isLoading ? 'Scanning…' : 'Scan for Duplicates'}
            </button>
          </div>
        </div>

        <div className="p-6 max-w-4xl">
          {/* Info banner */}
          <div className="flex items-start gap-3 p-4 rounded-xl border border-blue-500/20 bg-blue-500/5 mb-6">
            <Info className="h-4 w-4 text-blue-400 mt-0.5 shrink-0" />
            <div className="text-sm text-[var(--ff-text-secondary)]">
              <p className="font-medium text-[var(--ff-text-primary)] mb-0.5">How deduplication works</p>
              <p>
                ISAFlow matches customers by identical email, VAT number, or similar name.
                Merging moves all invoices, payments, quotes, sales orders, and credit notes
                to the customer you keep. The duplicate is then marked inactive.
              </p>
            </div>
          </div>

          {/* Error state */}
          {error && (
            <div className="flex items-center gap-2 p-4 rounded-xl border border-rose-500/20 bg-rose-500/5 text-rose-400 text-sm mb-6">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Not yet scanned */}
          {!scanned && !isLoading && !error && (
            <div className="text-center py-16">
              <Search className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">Ready to scan</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1 mb-4">
                Click "Scan for Duplicates" to find potential matches
              </p>
              <button
                onClick={scan}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
              >
                <Search className="h-4 w-4" />
                Scan for Duplicates
              </button>
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          )}

          {/* No duplicates */}
          {scanned && !isLoading && pairs.length === 0 && (
            <div className="text-center py-16">
              <CheckCircle2 className="h-12 w-12 text-teal-400 mx-auto mb-3" />
              <p className="text-[var(--ff-text-primary)] font-medium">No duplicates found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Your customer list looks clean</p>
            </div>
          )}

          {/* Pairs */}
          {!isLoading && pairs.length > 0 && (
            <>
              <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
                Found{' '}
                <span className="font-medium text-[var(--ff-text-primary)]">{pairs.length}</span>{' '}
                potential duplicate pair{pairs.length !== 1 ? 's' : ''}.
                Select which record to keep, then click Merge.
              </p>
              <div className="space-y-4">
                {pairs.map((pair) => (
                  <PairRow
                    key={`${pair.id_a}:${pair.id_b}`}
                    pair={pair}
                    onMergeRequest={(keepId, mergeId, keepName, mergeName) =>
                      setPending({ keepId, mergeId, keepName, mergeName })
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {pending && (
        <ConfirmModal
          keepName={pending.keepName}
          mergeName={pending.mergeName}
          onConfirm={handleMergeConfirm}
          onCancel={() => setPending(null)}
          isBusy={isMerging}
        />
      )}

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </AppLayout>
  );
}
