/**
 * BankTxListFrame — the transaction list's notices (transfer re-link failure,
 * AI still categorising) and its loading / error / empty states; renders the
 * table (children) only when there are rows. One container for every state:
 * its height is held while the rows load, so the swap shifts nothing.
 */

import type { ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { BankTxTab } from './BankTxTabs';

interface Props {
  relinkFailed: boolean;
  aiPolling: number;
  isLoading: boolean;
  error: string;
  empty: boolean;
  tab: BankTxTab;
  children: ReactNode;
}

export function BankTxListFrame({ relinkFailed, aiPolling, isLoading, error, empty, tab, children }: Props) {
  return (
    <>
      {relinkFailed && (
        <div className="flex items-center gap-2 text-xs text-amber-400 py-1 pb-2">
          <AlertCircle className="h-3 w-3" /> Transfer re-linking failed for this account — counterpart transfers may still show as unallocated.
        </div>
      )}
      {aiPolling > 0 && (
        <div className="flex items-center gap-2 text-xs text-[var(--ff-text-secondary)] py-1 pb-2">
          <Loader2 className="h-3 w-3 animate-spin" /> AI is categorizing {aiPolling} transaction{aiPolling === 1 ? '' : 's'}…
        </div>
      )}
      <div className="min-h-[480px]">
        {isLoading ? (
          <div className="space-y-2 py-2" role="status" aria-busy="true" aria-label="Loading transactions">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-12 animate-pulse rounded bg-[var(--ff-bg-tertiary)]" />)}
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-red-400 py-8 justify-center"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
        ) : empty ? (
          <div data-testid="bank-tx-empty" className="text-center py-12 text-[var(--ff-text-secondary)]">
            No {tab === 'new' ? 'new' : tab === 'excluded' ? 'excluded' : 'reviewed'} transactions for this account
          </div>
        ) : children}
      </div>
    </>
  );
}
