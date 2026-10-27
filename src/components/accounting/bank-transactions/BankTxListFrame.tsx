/**
 * BankTxListFrame — the transaction list's notices (transfer re-link failure,
 * AI still categorising) and its loading / error / empty states; renders the
 * table (children) only when there are rows. While the rows load the frame
 * holds a full page, so swapping the skeleton for a full page of rows shifts
 * nothing; once loaded it fits the rows, so a short tab has no gap above the
 * pager.
 * No rows while `total` > 0 is a page past the end that usePageClamp is about
 * to leave: it shows the skeleton, never "No new transactions".
 */

import type { ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { BankTxTab } from './BankTxTabs';
import { BankTxLoading, BankTxEmpty, BANK_TX_FRAME_MIN_PX } from './BankTxListStates';

export { BANK_TX_PAGE_SIZE } from './BankTxListStates';

interface Props {
  relinkFailed: boolean;
  aiPolling: number;
  isLoading: boolean;
  error: string;
  empty: boolean;
  /** Rows matching the filters across every page, from the same load as `empty`. */
  total: number;
  tab: BankTxTab;
  children: ReactNode;
}

export function BankTxListFrame({ relinkFailed, aiPolling, isLoading, error, empty, total, tab, children }: Props) {
  const loading = isLoading || (empty && total > 0);
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
      <div data-testid="bank-tx-list-frame" style={loading ? { minHeight: BANK_TX_FRAME_MIN_PX } : undefined}>
        {loading ? (
          <BankTxLoading />
        ) : error ? (
          <div className="flex items-center gap-2 text-red-400 py-8 justify-center"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
        ) : empty ? (
          <BankTxEmpty tab={tab} />
        ) : children}
      </div>
    </>
  );
}
