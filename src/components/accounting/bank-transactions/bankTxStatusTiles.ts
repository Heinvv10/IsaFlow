/**
 * bankTxStatusTiles - what pressing a status tile does to the bank-transactions view (WP4b). The Allocated, Suggested
 * and Unallocated tiles are toggles of the list's status filter (`allocationFilter`, the same `allocationCond` buckets
 * the tiles count with): pressed, the list shows that bucket on the New tab, where the status filter lives and where
 * lines are coded; pressed again, the filter is dropped and the tab stays. Excluded is not a status bucket but a tab, so
 * its tile toggles the Excluded tab.
 */

import type { BankTxTab } from './BankTxTabs';
import type { AllocationFilter } from './useBankTxFilters';

export type StatusTile = 'allocated' | 'suggested' | 'unallocated' | 'excluded';

interface View { tab: BankTxTab; allocationFilter: AllocationFilter }

export function statusTileClick(view: View, tile: StatusTile): View {
  if (tile === 'excluded') return { tab: view.tab === 'excluded' ? 'new' : 'excluded', allocationFilter: 'all' };
  if (view.allocationFilter === tile) return { tab: view.tab, allocationFilter: 'all' };
  return { tab: 'new', allocationFilter: tile };
}

/** Whether a tile reads as pressed for the view on screen. */
export function statusTilePressed(view: View, tile: StatusTile): boolean {
  return tile === 'excluded' ? view.tab === 'excluded' : view.allocationFilter === tile;
}
