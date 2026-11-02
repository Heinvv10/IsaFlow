/**
 * BankTxListFrame — the transaction list's notices (transfer re-link failure,
 * AI still categorising) and its loading / error / empty states; renders the
 * table (children) only when there are rows. While the rows load the frame
 * holds a full page, so swapping the skeleton for a full page of rows shifts
 * nothing; once loaded it fits the rows, so a short tab has no gap above the
 * pager.
 * No rows on a page past the end (bankTxPastEnd) is a page usePageClamp is
 * about to leave: it shows the skeleton, never "No new transactions". Any
 * other empty page says empty, so nothing can leave the skeleton stuck. A failed load also
 * has no rows and a zero total, but usePageClamp skips it: it shows the error, never the skeleton.
 * The bank line drawer lives here, outside BankTxTable's keydown container: a key pressed in the drawer must never
 * reach the grid's hotkeys, which post.
 */

import type { ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import type { BankTx } from '@/components/accounting/BankTxTable';
import { BankLineDrawerBody } from './BankLineDrawerBody';
import type { BankTxTab } from './BankTxTabs';
import { BankTxLoading, BankTxEmpty, BANK_TX_FRAME_MIN_PX } from './BankTxListStates';

export { BANK_TX_PAGE_SIZE } from './BankTxListStates';

interface Props {
  relinkFailed: boolean;
  aiPolling: number;
  isLoading: boolean;
  error: string;
  empty: boolean;
  /** bankTxPastEnd(page, total, pageSize), from the same load as `empty`. */
  pastEnd: boolean;
  tab: BankTxTab;
  /** The line whose drawer is open; undefined once it is off the list. */
  detailTx?: BankTx;
  onDetailClose: () => void;
  children: ReactNode;
}

export function BankTxListFrame({ relinkFailed, aiPolling, isLoading, error, empty, pastEnd, tab, detailTx, onDetailClose, children }: Props) {
  const loading = isLoading || (!error && empty && pastEnd);
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
      <Drawer open={detailTx !== undefined} onClose={onDetailClose} title="Bank line">
        {detailTx && <BankLineDrawerBody key={detailTx.id} tx={detailTx} />}
      </Drawer>
    </>
  );
}
