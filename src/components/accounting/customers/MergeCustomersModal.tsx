/**
 * Merge Customers Modal
 * Shows two customer cards side-by-side and confirms a merge operation.
 * The "target" customer is the one that will be kept active.
 * The "source" customer will have all its data re-parented and be soft-deleted.
 */

import { useState } from 'react';
import { ArrowLeftRight, AlertTriangle, Loader2, X, FileText, Mail, Hash } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

export interface MergeCandidate {
  id: string;
  name: string;
  email: string | null;
  vat: string | null;
  invoiceCount: number;
}

interface Props {
  candidateA: MergeCandidate;
  candidateB: MergeCandidate;
  onClose: () => void;
  onMerged: (targetId: string) => void;
}

function CustomerCard({
  customer,
  role,
}: {
  customer: MergeCandidate;
  role: 'keep' | 'merge';
}) {
  const isKeep = role === 'keep';
  return (
    <div
      className={`flex-1 rounded-lg border p-4 space-y-3 ${
        isKeep
          ? 'border-teal-500/50 bg-teal-500/5'
          : 'border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]'
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${
            isKeep
              ? 'bg-teal-500/20 text-teal-400'
              : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]'
          }`}
        >
          {isKeep ? 'Keep' : 'Merge into it'}
        </span>
      </div>

      <div>
        <p className="text-base font-semibold text-[var(--ff-text-primary)] leading-snug">
          {customer.name}
        </p>
      </div>

      <div className="space-y-1.5">
        {customer.email && (
          <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
            <Mail className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)] shrink-0" />
            <span className="truncate">{customer.email}</span>
          </div>
        )}
        {customer.vat && (
          <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
            <Hash className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)] shrink-0" />
            <span>VAT: {customer.vat}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <FileText className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)] shrink-0" />
          <span>{customer.invoiceCount} invoice{customer.invoiceCount !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  );
}

export function MergeCustomersModal({ candidateA, candidateB, onClose, onMerged }: Props) {
  // target = keep, source = will be merged away
  const [target, setTarget] = useState<MergeCandidate>(candidateA);
  const [source, setSource] = useState<MergeCandidate>(candidateB);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState('');

  const handleSwap = () => {
    setTarget(source);
    setSource(target);
  };

  const handleMerge = async () => {
    setIsMerging(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: source.id, target_id: target.id }),
      });
      const json = await res.json() as { data?: { merged: boolean; target_id: string }; message?: string };
      if (!res.ok) {
        setError(json.message ?? 'Merge failed. Please try again.');
        return;
      }
      const targetId = json.data?.target_id ?? target.id;
      onMerged(targetId);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ff-border-primary)]">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-teal-500" />
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Merge Customers</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Cards row */}
          <div className="flex gap-3 items-stretch">
            <CustomerCard customer={target} role="keep" />

            <div className="flex flex-col items-center justify-center gap-2">
              <div className="text-xs text-[var(--ff-text-tertiary)] font-medium">absorbs</div>
              <button
                onClick={handleSwap}
                title="Swap source and target"
                className="p-2 rounded-lg border border-[var(--ff-border-primary)] hover:border-teal-500/50 bg-[var(--ff-bg-secondary)] hover:bg-teal-500/5 text-[var(--ff-text-secondary)] hover:text-teal-400 transition-colors"
              >
                <ArrowLeftRight className="h-4 w-4" />
              </button>
              <div className="text-xs text-[var(--ff-text-tertiary)]">swap</div>
            </div>

            <CustomerCard customer={source} role="merge" />
          </div>

          {/* Warning */}
          <div className="flex gap-3 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-300 leading-relaxed">
              This will move all invoices, payments, contacts and delivery addresses from{' '}
              <span className="font-semibold">{source.name}</span> into{' '}
              <span className="font-semibold">{target.name}</span>.{' '}
              <span className="font-semibold">{source.name}</span> will be marked inactive and renamed with{' '}
              <span className="font-mono text-xs">[MERGED]</span>. This action cannot be undone automatically.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-[var(--ff-border-primary)]">
          <button
            onClick={onClose}
            disabled={isMerging}
            className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-[var(--ff-border-secondary)] text-sm font-medium transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleMerge()}
            disabled={isMerging}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {isMerging ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <ArrowLeftRight className="h-4 w-4" />
                Confirm Merge
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
