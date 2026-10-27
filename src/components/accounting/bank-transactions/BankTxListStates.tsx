/**
 * BankTxListStates: the loading and empty states of the bank transactions
 * list, and the page size and height they are drawn to. The skeleton is a
 * full page of rows at the grid's measured row height (1568 px wide, Demo,
 * 2026-10-27: header 34, row 41, keyboard-hint footer 33), and the frame
 * holds that height, so the swap to rows shifts nothing.
 */
import type { BankTxTab } from './BankTxTabs';
import { Skeleton } from '@/components/ui/Skeleton';

export const BANK_TX_PAGE_SIZE = 25;
export const BANK_TX_ROW_PX = 41;
const HEADER_PX = 34;
const FOOTER_PX = 33;
export const BANK_TX_FRAME_MIN_PX = HEADER_PX + BANK_TX_PAGE_SIZE * BANK_TX_ROW_PX + FOOTER_PX;

export function BankTxLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading transactions" data-testid="list-skeleton"
      className="px-2" style={{ paddingTop: HEADER_PX }}>
      {/* h-[41px] is BANK_TX_ROW_PX: Tailwind needs the literal class. */}
      <Skeleton variant="table-row" count={BANK_TX_PAGE_SIZE} className="h-[41px] items-center" />
    </div>
  );
}

export function BankTxEmpty({ tab }: { tab: BankTxTab }) {
  return (
    <div data-testid="bank-tx-empty" className="text-center py-12 text-[var(--ff-text-secondary)]">
      No {tab === 'new' ? 'new' : tab === 'excluded' ? 'excluded' : 'reviewed'} transactions for this account
    </div>
  );
}
