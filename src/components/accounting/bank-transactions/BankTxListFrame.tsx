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

import { useEffect, useRef, type ReactNode } from 'react';
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
  /** The same list is reloading: its rows stay mounted (dimmed, aria-busy) instead of becoming a skeleton. */
  refreshing?: boolean;
  error: string;
  empty: boolean;
  /** bankTxPastEnd(page, total, pageSize), from the same load as `empty`. */
  pastEnd: boolean;
  tab: BankTxTab;
  /** What narrows the list (ActiveFiltersChip's labels): the empty state names them. */
  activeFilters?: string[];
  /** The line whose drawer is open; undefined once it is off the list. */
  detailTx?: BankTx;
  onDetailClose: () => void;
  children: ReactNode;
}

export function BankTxListFrame({ relinkFailed, aiPolling, isLoading, refreshing = false, error, empty, pastEnd, tab, activeFilters, detailTx, onDetailClose, children }: Props) {
  const loading = isLoading || (!error && empty && pastEnd);
  const frameRef = useRef<HTMLDivElement>(null);
  const hadRows = useRef(false);
  const showsRows = !loading && !error && !empty;
  const showsEmpty = !loading && !error && empty;
  // The last row was accepted: the grid that held the keyboard focus is gone, so the empty state takes it (not <body>).
  useEffect(() => {
    if (showsRows) hadRows.current = true;
    else if (showsEmpty && hadRows.current) {
      hadRows.current = false;
      if (!document.activeElement || document.activeElement === document.body) frameRef.current?.focus();
    }
  }, [showsRows, showsEmpty]);
  return (
    <>
      {relinkFailed && (
        <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 py-1 pb-2">
          <AlertCircle className="h-3 w-3" /> Transfer re-linking failed for this account — counterpart transfers may still show as unallocated.
        </div>
      )}
      {aiPolling > 0 && (
        <div className="flex items-center gap-2 text-xs text-[var(--ff-text-secondary)] py-1 pb-2">
          <Loader2 className="h-3 w-3 animate-spin" /> AI is categorizing {aiPolling} transaction{aiPolling === 1 ? '' : 's'}…
        </div>
      )}
      {/* Announced politely when a reload of the SAME list starts; present before it does, so the change is heard. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="bank-tx-updating">{refreshing ? 'Updating…' : ''}</span>
      {/* While it reloads the rows stay (no flash) but take no mouse input: a click would land on a row that is about to change. */}
      <div data-testid="bank-tx-list-frame" ref={frameRef} tabIndex={-1} style={loading ? { minHeight: BANK_TX_FRAME_MIN_PX } : undefined}
        aria-busy={refreshing || undefined} className={refreshing ? 'outline-none pointer-events-none opacity-70 transition-opacity' : 'outline-none'}>
        {loading ? (
          <BankTxLoading />
        ) : error ? (
          <div className="flex items-center gap-2 text-red-700 dark:text-red-400 py-8 justify-center"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
        ) : empty ? (
          <BankTxEmpty tab={tab} activeFilters={activeFilters} />
        ) : children}
      </div>
      <Drawer open={detailTx !== undefined} onClose={onDetailClose} title="Bank line">
        {detailTx && <BankLineDrawerBody key={detailTx.id} tx={detailTx} />}
      </Drawer>
    </>
  );
}
