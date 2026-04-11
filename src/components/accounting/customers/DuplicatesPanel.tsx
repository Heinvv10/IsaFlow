/**
 * Duplicate Customers Panel
 * Collapsible panel that lists potential duplicate customer pairs
 * and lets the user open the merge modal for each.
 */

import { AlertCircle, GitMerge, Loader2, X } from 'lucide-react';
import type { DuplicatePair } from '@/types/customer-duplicates';

const MATCH_LABEL: Record<DuplicatePair['match_reason'], string> = {
  email: 'Same email',
  vat: 'Same VAT',
  name: 'Similar name',
};

const MATCH_COLOR: Record<DuplicatePair['match_reason'], string> = {
  email: 'bg-blue-500/10 text-blue-400',
  vat: 'bg-purple-500/10 text-purple-400',
  name: 'bg-amber-500/10 text-amber-400',
};

interface Props {
  pairs: DuplicatePair[];
  isLoading: boolean;
  error: string;
  onClose: () => void;
  onMerge: (pair: DuplicatePair) => void;
}

export function DuplicatesPanel({ pairs, isLoading, error, onClose, onMerge }: Props) {
  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ff-border-primary)]">
        <div className="flex items-center gap-2">
          <GitMerge className="h-4 w-4 text-teal-500" />
          <span className="text-sm font-medium text-[var(--ff-text-primary)]">Potential Duplicates</span>
          {!isLoading && !error && (
            <span className="text-xs text-[var(--ff-text-tertiary)]">
              ({pairs.length} pair{pairs.length !== 1 ? 's' : ''} found)
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close duplicates panel"
          className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center gap-2 text-red-400 py-6">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">{error}</span>
          </div>
        ) : pairs.length === 0 ? (
          <div className="text-center py-8">
            <GitMerge className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
            <p className="text-sm text-[var(--ff-text-secondary)]">No duplicate customers found</p>
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Your customer list looks clean!</p>
          </div>
        ) : (
          <div className="space-y-2">
            {pairs.map((pair) => (
              <div
                key={`${pair.id_a}-${pair.id_b}`}
                className="flex items-center gap-3 p-3 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] hover:border-teal-500/30 transition-colors"
              >
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${MATCH_COLOR[pair.match_reason]}`}>
                  {MATCH_LABEL[pair.match_reason]}
                </span>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--ff-text-primary)] truncate">{pair.name_a}</p>
                  {pair.email_a && (
                    <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{pair.email_a}</p>
                  )}
                  <p className="text-xs text-[var(--ff-text-tertiary)]">
                    {pair.invoice_count_a} invoice{pair.invoice_count_a !== 1 ? 's' : ''}
                  </p>
                </div>

                <GitMerge className="h-4 w-4 text-[var(--ff-text-tertiary)] shrink-0" />

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--ff-text-primary)] truncate">{pair.name_b}</p>
                  {pair.email_b && (
                    <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{pair.email_b}</p>
                  )}
                  <p className="text-xs text-[var(--ff-text-tertiary)]">
                    {pair.invoice_count_b} invoice{pair.invoice_count_b !== 1 ? 's' : ''}
                  </p>
                </div>

                <button
                  onClick={() => onMerge(pair)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium transition-colors"
                >
                  <GitMerge className="h-3.5 w-3.5" />
                  Merge
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
